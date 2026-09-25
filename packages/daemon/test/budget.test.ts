import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

describe("the per-card budget", () => {
	it("pauses the pipeline at the budget gate when a card's spend reaches it, and approving continues where it paused", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		// The scripted sessions cost $0.001 each, so the budget is reached right after the build.
		await h.api("PATCH", `/api/projects/${project.id}`, { budgetUsd: 0.0015, verifyCommand: "true" });
		const card = (await h.api("POST", `/api/cards`, { projectId: project.id, title: "Add feature" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		// The plan alone is under budget: the plan gate is the usual one.
		const planGate = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.find((gate: { kind: string }) => gate.kind === "plan_approval");
		await h.api("POST", `/api/cards/${card.id}/gates/${planGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();

		// Plan + build = $0.002, over the line: the card pauses for its person, mid-pipeline.
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "building", status: "running" });
		const budgetGate = detail.gates.find((gate: { kind: string; status: string }) => gate.kind === "budget");
		expect(budgetGate).toMatchObject({ status: "pending" });
		expect(budgetGate.feedback).toContain("$0.002 of the $0.0015");

		// Approving replays the settle: verify runs, the card reaches its usual feedback gate.
		await h.api("POST", `/api/cards/${card.id}/gates/${budgetGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const resumed = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(resumed.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		const feedbackGate = resumed.gates.find((gate: { kind: string; status: string }) => gate.kind === "feedback" && gate.status === "pending");
		await h.api("POST", `/api/cards/${card.id}/gates/${feedbackGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const done = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(done).toMatchObject({ stage: "done", status: "idle" });
		// The approval is remembered: later settles over the line do not re-gate.
		expect(detail.gates.filter((gate: { kind: string }) => gate.kind === "budget")).toHaveLength(1);
		// The drawer can meter the spend while the card runs: detail carries spend + budget.
		const spend = (await h.api("GET", `/api/cards/${card.id}`)).body.spend;
		expect(spend).toMatchObject({ budgetUsd: 0.0015 });
		expect(spend.spentUsd).toBeGreaterThan(0);
	});

	it("declining parks the card with the reason, and raising the budget lets Retry continue", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		// Acceptance flows stay off: this test is about the budget, and the bare harness repo has no runner.
		await h.api("PATCH", `/api/projects/${project.id}`, { budgetUsd: 0.0005, verifyCommand: "true", acceptanceGates: false });
		const card = (await h.api("POST", `/api/cards`, { projectId: project.id, title: "Add feature" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		const budgetGate = detail.gates.find((gate: { kind: string }) => gate.kind === "budget");
		expect(detail.card).toMatchObject({ stage: "planning", status: "running" });

		await h.api("POST", `/api/cards/${card.id}/gates/${budgetGate.id}`, { decision: "reject", feedback: "too rich for this card" });
		const stuck = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(stuck).toMatchObject({ stage: "planning", status: "needs_attention" });
		expect(stuck.needsAttentionReason).toContain("Budget declined");
		expect(stuck.needsAttentionReason).toContain("too rich for this card");

		// The person raises the budget; Retry continues the settled plan instead of re-planning it.
		await h.api("PATCH", `/api/projects/${project.id}`, { budgetUsd: 1 });
		await h.api("POST", `/api/cards/${card.id}/retry`);
		await h.daemon.whenIdle();
		// Continuing lands at the plan's own gate (the plan was fine; only the money argued).
		const resumed = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(resumed.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		const resumedGate = resumed.gates.find((gate: { kind: string; status: string }) => gate.kind === "plan_approval" && gate.status === "pending");
		await h.api("POST", `/api/cards/${card.id}/gates/${resumedGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const atFeedback = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(atFeedback.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		const feedbackGate = atFeedback.gates.find((gate: { kind: string; status: string }) => gate.kind === "feedback" && gate.status === "pending");
		await h.api("POST", `/api/cards/${card.id}/gates/${feedbackGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const done = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(done).toMatchObject({ stage: "done", status: "idle" });
		// The plan was not paid for twice: one planning session, from either path.
		const plans = (await h.api("GET", `/api/cards/${card.id}`)).body.runs.filter((run: { id: string }) => run.id.includes("-plan-"));
		expect(plans).toHaveLength(1);
	});
});
