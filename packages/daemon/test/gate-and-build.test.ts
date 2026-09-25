import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("stacked cards", () => {
	it("a card stacked on another starts from that card's branch and sees its work", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const base = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Foundation" })).body;
		await h.api("POST", `/api/cards/${base.id}/enqueue`);
		await h.daemon.whenIdle();
		const baseGate = (await h.api("GET", `/api/cards/${base.id}`)).body.gates[0];
		await h.api("POST", `/api/cards/${base.id}/gates/${baseGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		// The base is built: its branch carries feature.txt, unmerged.
		const baseBranch = (await h.api("GET", `/api/cards/${base.id}`)).body.card.branchName;

		// Stacking refuses a card of another project and accepts one of the same project.
		const other = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		expect((await h.api("POST", "/api/cards", { projectId: other.id, title: "x", baseCardId: base.id })).status).toBe(400);
		const stacked = (await h.api("POST", "/api/cards", { projectId: project.id, title: "On top", baseCardId: base.id })).body;
		expect(stacked).toMatchObject({ baseCardId: base.id });
		await h.api("POST", `/api/cards/${stacked.id}/enqueue`);
		await h.daemon.whenIdle();
		const stackGate = (await h.api("GET", `/api/cards/${stacked.id}`)).body.gates[0];
		await h.api("POST", `/api/cards/${stacked.id}/gates/${stackGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();

		// The stacked card's worktree started from the base's branch: the base's file is there.
		const stackWorktree = (await h.api("GET", `/api/cards/${stacked.id}`)).body.card.worktreePath;
		expect(readFileSync(join(stackWorktree, "feature.txt"), "utf8")).toContain("built by");
		const mergeBase = execFileSync("git", ["merge-base", (await h.api("GET", `/api/cards/${stacked.id}`)).body.card.branchName, baseBranch], { cwd: h.repo, encoding: "utf8" }).trim();
		const baseTip = execFileSync("git", ["rev-parse", baseBranch], { cwd: h.repo, encoding: "utf8" }).trim();
		expect(mergeBase).toBe(baseTip);
	});

	it("a stacked card falls back to the default branch when the base's branch is gone", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const base = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Gone soon" })).body;
		await h.api("POST", `/api/cards/${base.id}/enqueue`);
		await h.daemon.whenIdle();
		// The base's branch is gone (as after a finish-and-cleanup), but the row is what the stack points at.
		const goneBranch = (await h.api("GET", `/api/cards/${base.id}`)).body.card.branchName;
		execFileSync("git", ["worktree", "remove", "--force", (await h.api("GET", `/api/cards/${base.id}`)).body.card.worktreePath], { cwd: h.repo });
		execFileSync("git", ["branch", "-D", goneBranch], { cwd: h.repo });
		const stacked = (await h.api("POST", "/api/cards", { projectId: project.id, title: "On top", baseCardId: base.id })).body;
		await h.api("POST", `/api/cards/${stacked.id}/enqueue`);
		await h.daemon.whenIdle();
		// It still planned and built — on the default branch.
		const worktree = (await h.api("GET", `/api/cards/${stacked.id}`)).body.card.worktreePath;
		expect(readFileSync(join(worktree, "README.md"), "utf8")).toContain("test repo");
	});
});

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
