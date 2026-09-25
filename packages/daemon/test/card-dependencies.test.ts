import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
	const harness = h;
	h = undefined as unknown as Harness;
	await harness?.close();
});

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

describe("card dependencies", () => {
	it("a dependent card keeps its queue place until the card it waits for lands", async () => {
		h = await bootHarness(byStage(), ENV);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		await h.api("PATCH", `/api/projects/${project.id}`, { verifyCommand: "true" });

		const first = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Foundations", brief: "Schema and shared types first." })).body;
		const second = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Build on top", brief: "Needs the schema.", dependsOn: first.id })).body;
		expect(second.dependsOn).toBe(first.id);
		// A dependency names a real, unlanded card of the same project.
		expect((await h.api("POST", "/api/cards", { projectId: project.id, title: "Nope", dependsOn: "no-such-card" })).status).toBe(400);

		await h.api("POST", `/api/cards/${first.id}/enqueue`);
		await h.api("POST", `/api/cards/${second.id}/enqueue`);
		await h.daemon.whenIdle();
		// The first card ran to its plan gate; the dependent kept its place in the queue.
		expect((await h.api("GET", `/api/cards/${first.id}`)).body.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		expect((await h.api("GET", `/api/cards/${second.id}`)).body.card).toMatchObject({ stage: "planning", status: "queued" });

		// The plan gate and then the feedback gate: the person's two decisions on the first card.
		const planGate = (await h.api("GET", `/api/cards/${first.id}`)).body.gates.find((gate: { status: string }) => gate.status === "pending");
		await h.api("POST", `/api/cards/${first.id}/gates/${planGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const feedbackGate = (await h.api("GET", `/api/cards/${first.id}`)).body.gates.find((gate: { status: string }) => gate.status === "pending");
		expect(feedbackGate.kind).toBe("feedback");
		// Not landed yet: the dependent still waits, even though a slot is free.
		expect((await h.api("GET", `/api/cards/${second.id}`)).body.card.status).toBe("queued");

		await h.api("POST", `/api/cards/${first.id}/gates/${feedbackGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${first.id}`)).body.card).toMatchObject({ stage: "done" });
		// The wait is over: the dependent takes the freed slot and plans — straight through to its gate.
		expect(h.driver.handles.some((handle) => handle.sessionId === `c${second.id}-plan-1`)).toBe(true);
		expect((await h.api("GET", `/api/cards/${second.id}`)).body.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
	});

	it("deleting the card a dependent waits for releases the dependent instead of stranding it", async () => {
		h = await bootHarness(byStage(), ENV);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;

		const base = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Base" })).body;
		const dependent = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Dependent", dependsOn: base.id })).body;
		await h.api("POST", `/api/cards/${dependent.id}/enqueue`);
		await h.daemon.whenIdle();
		// The base is a resting backlog card; the dependent waits for it.
		expect((await h.api("GET", `/api/cards/${dependent.id}`)).body.card.status).toBe("queued");

		await h.api("DELETE", `/api/cards/${base.id}`);
		await h.daemon.whenIdle();
		// No stranded wait: the dependency is gone, the card plans.
		const after = (await h.api("GET", `/api/cards/${dependent.id}`)).body.card;
		expect(after.dependsOn).toBeNull();
		expect(h.driver.handles.some((handle) => handle.sessionId === `c${dependent.id}-plan-1`)).toBe(true);
	});
});
