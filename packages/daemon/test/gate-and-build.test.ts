import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { bootHarness, buildingTurn, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

async function planCard(harness: Harness) {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: "Add feature", brief: "Make it so." })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	const detail = (await harness.api("GET", `/api/cards/${card.id}`)).body;
	return { card, gate: detail.gates[0] };
}

describe("plan gate and building handoff", () => {
	it("holds a finished plan at a pending gate until a human decides", async () => {
		h = await bootHarness(byStage());
		const { card, gate } = await planCard(h);
		expect(gate).toMatchObject({ kind: "plan_approval", status: "pending" });
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card.status).toBe("awaiting_gate");
		expect(h.driver.handles).toHaveLength(1);
	});

	it("approval builds in a fresh session that sees the plan path but none of the planning conversation", async () => {
		h = await bootHarness(byStage());
		const { card, gate } = await planCard(h);
		const approved = await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		expect(approved.body).toMatchObject({ stage: "building", status: "queued" });
		await h.daemon.whenIdle();

		const [planner, builder, tester] = h.driver.handles;
		expect(tester?.sessionId).toBe(`c${card.id}-test-1`);
		expect(builder?.sessionId).toBe(`c${card.id}-build-1`);
		expect(builder?.sessionId).not.toBe(planner?.sessionId);
		expect(builder?.spec.cwd).toBe(planner?.spec.cwd);
		// Tiering: the expensive model planned, the cheap one builds, with write access.
		expect(planner?.spec.model).toBe("anthropic/claude-fable-5-1");
		expect(builder?.spec.model).toBe("zai/glm-5.3");
		expect(builder?.spec.tools).toContain("edit");
		expect(builder?.prompts[0]).toContain(`cards/${card.id}/plan.md`);
		expect(builder?.prompts[0]).not.toContain("Produce an implementation plan");

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		expect(detail.gates[0]).toMatchObject({ status: "approved" });
		expect(detail.runs.map((r: { stage: string; resultStatus: string }) => [r.stage, r.resultStatus])).toEqual([
			["planning", "pass"],
			["building", "pass"],
			["testing", "pass"],
		]);

		const diff = (await h.api("GET", `/api/cards/${card.id}/diff`)).body;
		expect(diff.diff).toContain("+new feature");
		expect(diff.diff).toContain(`+built by c${card.id}-build-1`);
		expect(diff.untracked).toEqual(["scratch.tmp"]);
	});

	it("rejection re-plans in a new session with the feedback, then gates again", async () => {
		h = await bootHarness(byStage());
		const { card, gate } = await planCard(h);
		expect((await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "reject" })).status).toBe(400);
		const rejected = await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "reject", feedback: "Split this into two steps." });
		expect(rejected.body).toMatchObject({ stage: "planning", status: "queued" });
		await h.daemon.whenIdle();

		const replan = h.driver.handles[1];
		expect(replan?.sessionId).toBe(`c${card.id}-plan-2`);
		expect(replan?.prompts[0]).toContain("Split this into two steps.");
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card.status).toBe("awaiting_gate");
		expect(detail.gates.map((g: { status: string }) => g.status)).toEqual(["rejected", "pending"]);
	});

	it("refuses to decide a gate twice or to decide another card's gate", async () => {
		h = await bootHarness(byStage());
		const { card, gate } = await planCard(h);
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		expect((await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" })).status).toBe(409);
		expect((await h.api("POST", `/api/cards/${card.id}/gates/nope`, { decision: "approve" })).status).toBe(404);
		// planner, builder, tester: the second approval started nothing.
		expect(h.driver.handles).toHaveLength(3);
	});

	it("a build that reports failure asks for attention, and retry re-runs it with guidance", async () => {
		let builds = 0;
		h = await bootHarness(
			byStage({
				build: () =>
					++builds === 1
						? { events: [], effect: ({ spec }) => writeFileSync(`${spec.sessionDir}/../stage-result.json`, '{"status":"fail","summary":"Tests are red."}') }
						: buildingTurn(),
			}),
		);
		const { card, gate } = await planCard(h);
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "building", status: "needs_attention", needsAttentionReason: "fail: Tests are red." });

		expect((await h.api("POST", `/api/cards/${card.id}/retry`, { feedback: "Run pnpm install first." })).status).toBe(202);
		await h.daemon.whenIdle();
		expect(h.driver.handles[2]?.sessionId).toBe(`c${card.id}-build-2`);
		expect(h.driver.handles[2]?.prompts[0]).toContain("Run pnpm install first.");
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "feedback", status: "awaiting_gate", needsAttentionReason: null });
	});
});
