import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { byStage, bootHarness, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

const addProject = async (): Promise<{ id: string }> => (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
const addCard = async (projectId: string): Promise<{ id: string }> =>
	(await h.api("POST", "/api/cards", { projectId, title: "Add retry with backoff", brief: "5xx responses should be retried." })).body;

async function approvePlanGate(cardId: string): Promise<void> {
	const detail = (await h.api("GET", `/api/cards/${cardId}`)).body;
	const gate = detail.gates.find((gate: { status: string }) => gate.status === "pending");
	if (gate) await h.api("POST", `/api/cards/${cardId}/gates/${gate.id}`, { decision: "approve", feedback: "" });
	await h.daemon.whenIdle();
}

const NOTE = { artifact: "plan.md", quote: "Requests to the payments API fail", note: "Scope this to 5xx only — timeouts are a separate card." };

describe("margin notes", () => {
	it("pins a note to plan text, records it, and refuses nonsense", async () => {
		h = await bootHarness(byStage(), ENV);
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		const added = await h.api("POST", `/api/cards/${card.id}/annotations`, NOTE);
		expect(added.status).toBe(201);
		expect(added.body.annotation).toMatchObject({ artifact: "plan.md", resolved: false, note: NOTE.note });
		expect(added.body.annotations).toHaveLength(1);

		// The card carries the notes; the folder carries the record the agents read.
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.annotations).toHaveLength(1);
		expect(detail.artifacts.map((a: { name: string }) => a.name)).toContain("annotations.md");
		const saved = readFileSync(join(h.home, "cards", card.id, "annotations.md"), "utf8");
		expect(saved).toContain("Margin notes");
		expect(saved).toContain("**(open)**");
		expect(saved).toContain(NOTE.note);

		expect((await h.api("POST", `/api/cards/${card.id}/annotations`, { ...NOTE, artifact: "no-such-file.md" })).status).toBe(400);
		expect((await h.api("POST", `/api/cards/${card.id}/annotations`, { ...NOTE, quote: "no" })).status).toBe(400);
		expect((await h.api("POST", `/api/cards/${card.id}/annotations`, { ...NOTE, note: "   " })).status).toBe(400);
	});

	it("a rejection can be notes alone, and the planner is re-planned with them", async () => {
		h = await bootHarness(byStage(), ENV);
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		await h.api("POST", `/api/cards/${card.id}/annotations`, NOTE);

		// No typed feedback: the note is the what-should-change.
		const rejected = await h.api("POST", `/api/cards/${card.id}/gates/${(await h.api("GET", `/api/cards/${card.id}`)).body.gates.find((g: { status: string }) => g.status === "pending").id}`, { decision: "reject", feedback: "" });
		expect(rejected.status).toBe(200);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		const gate = detail.gates.find((g: { status: string }) => g.status === "rejected");
		expect(gate?.feedback).toContain("margin notes");
		expect(gate?.feedback).toContain(NOTE.note);

		// The re-plan sees the note twice: as its feedback, and as a margin-notes block.
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		const replans = h.driver.handles.filter((handle) => handle.sessionId.includes("-plan-"));
		expect(replans).toHaveLength(2);
		expect(replans[1]?.prompts[0]).toContain("Margin notes");
		expect(replans[1]?.prompts[0]).toContain(NOTE.note);
	});

	it("open notes reach the builder; resolving drops them from the prompt but keeps the record", async () => {
		h = await bootHarness(byStage(), ENV);
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const annotationId = (await h.api("POST", `/api/cards/${card.id}/annotations`, NOTE)).body.annotation.id;

		await approvePlanGate(card.id);
		await h.daemon.whenIdle();
		const builder = h.driver.handles.find((handle) => handle.sessionId.includes("-build-"));
		expect(builder?.prompts[0]).toContain("Margin notes");
		expect(builder?.prompts[0]).toContain(NOTE.note);

		const resolved = await h.api("PATCH", `/api/cards/${card.id}/annotations/${annotationId}`, { resolved: true });
		expect(resolved.body.annotations[0]).toMatchObject({ resolved: true });
		expect(readFileSync(join(h.home, "cards", card.id, "annotations.md"), "utf8")).toContain("*(resolved)*");

		const removed = await h.api("DELETE", `/api/cards/${card.id}/annotations/${annotationId}`);
		expect(removed.body.annotations).toHaveLength(0);
		expect(((await h.api("GET", `/api/cards/${card.id}`)).body).annotations).toHaveLength(0);
		expect(((await h.api("PATCH", `/api/cards/${card.id}/annotations/${annotationId}`, { resolved: false })).status)).toBe(400);
		expect(existsSync(join(h.home, "cards", card.id, "annotations.json"))).toBe(true);
	});

	it("a card with no notes plans with an empty margin", async () => {
		h = await bootHarness(byStage(), ENV);
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const plan = h.driver.handles.find((handle) => handle.sessionId.includes("-plan-"));
		expect(plan?.prompts[0]).not.toContain("Margin notes");
		expect(((await h.api("GET", `/api/cards/${card.id}`)).body).annotations).toHaveLength(0);
	});
});
