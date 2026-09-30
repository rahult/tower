import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness, planningTurn } from "./harness.ts";

let h: Harness;
let h2: Harness;
afterEach(async () => {
	await h?.close();
	await h2?.close();
	h2 = undefined as unknown as Harness;
});

/** A project with a card driven to the plan-approval gate, the way the lifecycle tests do it. */
async function toPlanGate(harness: Harness) {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	await harness.api("PATCH", `/api/projects/${project.id}`, { verifyCommand: "true" });
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: "Add feature", brief: "Make it so." })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	const detail = (await harness.api("GET", `/api/cards/${card.id}`)).body;
	return { project, card, gate: detail.gates.find((g: { status: string }) => g.status === "pending") };
}

/** A card driven all the way to done: approve the plan gate, then the feedback gate, and it merges locally. */
async function toDone(harness: Harness) {
	const { project, card, gate } = await toPlanGate(harness);
	await harness.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
	await harness.daemon.whenIdle();
	const feedback = (await harness.api("GET", `/api/cards/${card.id}`)).body.gates.find((g: { status: string }) => g.status === "pending");
	await harness.api("POST", `/api/cards/${card.id}/gates/${feedback.id}`, { decision: "approve" });
	await harness.daemon.whenIdle();
	return { project, card: (await harness.api("GET", `/api/cards/${card.id}`)).body.card };
}

describe("archiving cards", () => {
	it("archiving a done card hides it from the default board and lists it under ?archived=1; unarchive restores it", async () => {
		h = await bootHarness(byStage());
		const { card } = await toDone(h);
		expect(card).toMatchObject({ stage: "done", status: "idle" });

		const archived = await h.api("POST", `/api/cards/${card.id}/archive`);
		expect(archived.status).toBe(200);
		expect(archived.body.archivedAt).toEqual(expect.any(Number));
		// The card itself is untouched — archiving never touches git.
		expect(archived.body).toMatchObject({ stage: "done", status: "idle", branchName: card.branchName });

		const active = (await h.api("GET", "/api/board")).body;
		expect(active.cards.find((candidate: { id: string }) => candidate.id === card.id)).toBeUndefined();
		const shelf = (await h.api("GET", "/api/board?archived=1")).body;
		expect(shelf.cards.map((candidate: { id: string }) => candidate.id)).toContain(card.id);
		// Detail still works: the board filter is a view, not a deletion.
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card.archivedAt).toEqual(expect.any(Number));

		const restored = await h.api("POST", `/api/cards/${card.id}/unarchive`);
		expect(restored.status).toBe(200);
		expect(restored.body.archivedAt).toBeNull();
		const board = (await h.api("GET", "/api/board")).body;
		expect(board.cards.map((candidate: { id: string }) => candidate.id)).toContain(card.id);
		expect((await h.api("GET", "/api/board?archived=1")).body.cards).toHaveLength(0);
	});

	it("archiving a live card is refused with 409, and so is a mid-stage card resting between stages", async () => {
		// A slow planner: the card is genuinely busy, not merely mid-stage.
		h = await bootHarness((spec) => (spec.sessionId.includes("-plan-") ? [planningTurn({ delayMs: 250 })] : byStage()(spec)));
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const busy = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Busy", brief: "" })).body;
		await h.api("POST", `/api/cards/${busy.id}/enqueue`);
		const refused = await h.api("POST", `/api/cards/${busy.id}/archive`);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toContain("busy");
		await h.api("POST", `/api/cards/${busy.id}/abort`);
		await h.daemon.whenIdle();

		// Mid-stage: resting at the plan gate — nothing live, just not finished or backlog.
		h2 = await bootHarness(byStage());
		const { card } = await toPlanGate(h2);
		const mid = await h2.api("POST", `/api/cards/${card.id}/archive`);
		expect(mid.status).toBe(409);
		expect(mid.body.error).toContain("finished card or a backlog card");
	});

	it("an archived backlog card is enqueued but never starts, while an active one does", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const hidden = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Hidden", brief: "" })).body;
		const active = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Active", brief: "" })).body;

		expect((await h.api("POST", `/api/cards/${hidden.id}/archive`)).status).toBe(200);
		await h.api("POST", `/api/cards/${hidden.id}/enqueue`);
		await h.api("POST", `/api/cards/${active.id}/enqueue`);
		await h.daemon.whenIdle();

		const sessions = h.driver.handles.map((handle) => handle.sessionId);
		expect(sessions.some((id) => id.startsWith(`c${active.id}-`))).toBe(true);
		expect(sessions.some((id) => id.startsWith(`c${hidden.id}-`))).toBe(false);
		// It stays queued forever — the scheduler simply never sees it.
		expect((await h.api("GET", `/api/cards/${hidden.id}`)).body.card.status).toBe("queued");
	});
});
