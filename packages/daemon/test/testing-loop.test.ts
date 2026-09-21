import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, buildingTurn, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

/** The builder writes FIXED into the worktree on its Nth build, which is what the verify command checks for. */
const fixesOnBuild = (n: number) => {
	let builds = 0;
	return byStage({
		build: () => {
			const fixes = ++builds >= n;
			const turn = buildingTurn();
			return {
				...turn,
				effect: async (ctx) => {
					await turn.effect?.(ctx);
					if (fixes) writeFileSync(join(ctx.spec.cwd, "FIXED"), "yes");
				},
			};
		},
	});
};

const VERIFY = 'if [ -f FIXED ]; then echo "all green"; else echo "1 test failed: expected FIXED"; exit 1; fi';

async function approvePlan(harness: Harness, settings: Record<string, string>) {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	expect((await harness.api("PATCH", `/api/projects/${project.id}`, settings)).body).toMatchObject(settings);
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: "Add feature" })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	const gate = (await harness.api("GET", `/api/cards/${card.id}`)).body.gates[0];
	await harness.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
	await harness.daemon.whenIdle();
	return { card, detail: (await harness.api("GET", `/api/cards/${card.id}`)).body };
}

describe("testing stage and the fail loop", () => {
	it("passes straight through when the verify command succeeds", async () => {
		h = await bootHarness(fixesOnBuild(1));
		const { detail } = await approvePlan(h, { verifyCommand: VERIFY });
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		expect(detail.runs.map((r: { kind: string; stage: string; resultStatus: string }) => [r.kind, r.stage, r.resultStatus])).toEqual([
			["stage", "planning", "pass"],
			["stage", "building", "pass"],
			["verify", "testing", "pass"],
		]);
	});

	it("sends failing output back to a fresh builder, then passes", async () => {
		h = await bootHarness(fixesOnBuild(2));
		const { card, detail } = await approvePlan(h, { verifyCommand: VERIFY });
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		expect(detail.runs.map((r: { id: string }) => r.id.replace(`c${card.id}-`, ""))).toEqual(["plan-1", "build-1", "verify-1", "build-2", "verify-2"]);

		const secondBuild = h.driver.handles[2];
		expect(secondBuild?.prompts[0]).toContain("1 test failed: expected FIXED");
		expect(detail.artifacts.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(["verify-output-1.txt", "verify-output-2.txt"]));

		// The verify command's output is a transcript like any session's.
		const log = (await h.api("GET", `/api/runs/c${card.id}-verify-1/transcript`)).body.items;
		expect(log.map((i: { type: string }) => i.type)).toEqual(["verify_started", "verify_output", "run_finished"]);
		expect(log[1].payload.text).toContain("1 test failed");
	});

	it("stops at the build-attempt cap and asks for attention", async () => {
		h = await bootHarness(fixesOnBuild(99));
		const { card, detail } = await approvePlan(h, { verifyCommand: VERIFY });
		expect(detail.card).toMatchObject({ stage: "testing", status: "needs_attention", needsAttentionReason: "Still failing after 3 build attempts." });
		expect(detail.runs.filter((r: { stage: string; kind: string }) => r.stage === "building")).toHaveLength(3);
		expect(detail.runs.filter((r: { kind: string }) => r.kind === "verify")).toHaveLength(3);

		// A human fix followed by Run again re-runs the verify command, not an agent.
		writeFileSync(join(detail.card.worktreePath, "FIXED"), "by hand");
		const sessions = h.driver.handles.length;
		expect((await h.api("POST", `/api/cards/${card.id}/retry`)).body).toMatchObject({ stage: "testing", status: "verifying" });
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		expect(h.driver.handles).toHaveLength(sessions);
	});

	it("uses a tester agent when the project has no verify command", async () => {
		h = await bootHarness(byStage());
		const { card, detail } = await approvePlan(h, {});
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		const tester = h.driver.handles[2];
		expect(tester?.sessionId).toBe(`c${card.id}-test-1`);
		expect(tester?.prompts[0]).toContain("Do **not** fix anything");
		expect(tester?.prompts[0]).toContain("test-report.md");
	});

	it("runs the setup command once, in the new worktree, before the first session", async () => {
		h = await bootHarness(fixesOnBuild(1));
		const { detail } = await approvePlan(h, { setupCommand: "echo ready >> .setup-ran", verifyCommand: VERIFY });
		const marker = join(detail.card.worktreePath, ".setup-ran");
		expect(existsSync(marker)).toBe(true);
		expect((await import("node:fs")).readFileSync(marker, "utf8")).toBe("ready\n");
	});

	it("a failing setup command stops the card before any tokens are spent", async () => {
		h = await bootHarness(fixesOnBuild(1));
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		await h.api("PATCH", `/api/projects/${project.id}`, { setupCommand: "echo no lockfile >&2; exit 3" });
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card.status).toBe("needs_attention");
		expect(detail.card.needsAttentionReason).toContain("no lockfile");
		expect(h.driver.handles).toHaveLength(0);
	});

	it("aborts a running verify command", async () => {
		h = await bootHarness(fixesOnBuild(1));
		const board = h.stream("board");
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		await h.api("PATCH", `/api/projects/${project.id}`, { verifyCommand: "sleep 30" });
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const gate = (await h.api("GET", `/api/cards/${card.id}`)).body.gates[0];
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await board.waitFor((f) => f.type === "card_upserted" && f.data.status === "verifying", 5000);

		const started = Date.now();
		expect((await h.api("POST", `/api/cards/${card.id}/abort`)).status).toBe(200);
		expect(Date.now() - started).toBeLessThan(5000);
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "testing", status: "idle" });
	});
});
