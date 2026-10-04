import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness, planningTurn } from "./harness.ts";

let h: Harness;
let h2: Harness;
afterEach(async () => {
	await h?.close();
	await h2?.close();
	h2 = undefined as unknown as Harness;
});

/** A card driven to the plan-approval gate: it has a worktree, a pending gate and a plan on disk. */
async function toPlanGate(harness: Harness, projectId: string, title = "Add feature") {
	const card = (await harness.api("POST", "/api/cards", { projectId, title, brief: "Make it so." })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	return (await harness.api("GET", `/api/cards/${card.id}`)).body;
}

const registeredWorktrees = (repo: string): string =>
	execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });

describe("deleting a project", () => {
	it("removes the project and every card filed under it, and its worktrees from the repository", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		await h.api("PATCH", `/api/projects/${project.id}`, { verifyCommand: "true" });

		// One card resting at the plan gate (it has a worktree), one still in the backlog.
		const rested = await toPlanGate(h, project.id);
		const backlog = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Later", brief: "" })).body;
		expect(rested.card.worktreePath).toBeTruthy();
		expect(existsSync(rested.card.worktreePath)).toBe(true);
		expect(registeredWorktrees(h.repo)).toContain(rested.card.worktreePath);

		const removed = await h.api("DELETE", `/api/projects/${project.id}`);
		expect(removed.status).toBe(200);
		expect(removed.body).toEqual({ ok: true, cards: 2 });

		const board = (await h.api("GET", "/api/board")).body;
		expect(board.projects.map((p: { id: string }) => p.id)).not.toContain(project.id);
		expect(board.cards.map((c: { id: string }) => c.id)).not.toContain(rested.card.id);
		expect(board.cards.map((c: { id: string }) => c.id)).not.toContain(backlog.id);

		// Both the project and its cards are gone, not merely hidden.
		expect((await h.api("GET", `/api/cards/${rested.card.id}`)).status).toBe(404);
		expect((await h.api("GET", `/api/cards/${backlog.id}`)).status).toBe(404);
		expect((await h.api("PATCH", `/api/projects/${project.id}`, { name: "ghost" })).status).toBe(404);

		// The repository stops advertising a worktree for a card that no longer exists.
		expect(existsSync(rested.card.worktreePath)).toBe(false);
		expect(registeredWorktrees(h.repo)).not.toContain(rested.card.worktreePath);
	});

	it("refuses while a card is busy, and deletes once it is aborted", async () => {
		h = await bootHarness((spec) => (spec.sessionId.includes("-plan-") ? [planningTurn({ delayMs: 250 })] : byStage()(spec)));
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Busy", brief: "" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);

		const refused = await h.api("DELETE", `/api/projects/${project.id}`);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toContain("busy");
		// Nothing was half-deleted.
		expect((await h.api("GET", `/api/cards/${card.id}`)).status).toBe(200);

		await h.api("POST", `/api/cards/${card.id}/abort`);
		await h.daemon.whenIdle();
		const removed = await h.api("DELETE", `/api/projects/${project.id}`);
		expect(removed.status).toBe(200);
		expect((await h.api("GET", "/api/board")).body.projects).toHaveLength(0);
	});

	it("deletes a project whose card is resting mid-stage, at a gate", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const detail = await toPlanGate(h, project.id);
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		expect(detail.gates.some((gate: { status: string }) => gate.status === "pending")).toBe(true);

		expect((await h.api("DELETE", `/api/projects/${project.id}`)).status).toBe(200);
		expect((await h.api("GET", `/api/cards/${detail.card.id}`)).status).toBe(404);
	});
});
