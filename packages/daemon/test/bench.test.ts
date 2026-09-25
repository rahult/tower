import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

/** A card with a worktree: planned, approved and built, resting at the feedback gate. */
async function builtCard(harness: Harness, settings: Record<string, string>) {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	await harness.api("PATCH", `/api/projects/${project.id}`, settings);
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: "Add feature" })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	const gate = (await harness.api("GET", `/api/cards/${card.id}`)).body.gates[0];
	await harness.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
	await harness.daemon.whenIdle();
	return card.id as string;
}

/** Polls the card detail until the newest test run settles, then returns it. */
async function settledTestRun(harness: Harness, cardId: string) {
	for (let i = 0; i < 200; i++) {
		const detail = (await harness.api("GET", `/api/cards/${cardId}`)).body;
		const run = detail.runs.findLast((r: { kind: string }) => r.kind === "test");
		if (run && run.status !== "running") return { run, detail };
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("test run did not settle");
}

describe("hands-on: running the project's tests from a card", () => {
	it("runs the test command in the card's worktree, streaming output, without touching the lifecycle", async () => {
		h = await bootHarness(byStage());
		const cardId = await builtCard(h, { testCommand: 'echo "3 tests passed"; echo "1 skipped"' });
		const before = (await h.api("GET", `/api/cards/${cardId}`)).body.card;
		const started = await h.api("POST", `/api/cards/${cardId}/test`);
		expect(started.status).toBe(202);
		expect(started.body.run).toMatchObject({ kind: "test", status: "running", model: 'echo "3 tests passed"; echo "1 skipped"' });

		const { run, detail } = await settledTestRun(h, cardId);
		expect(run).toMatchObject({ status: "settled", resultStatus: "pass", resultSummary: "Tests passed." });
		// The card itself never moved: a person's test run cannot pass or fail it.
		expect(detail.card).toMatchObject({ stage: before.stage, status: before.status });

		// The output is a transcript like any other run's.
		const log = (await h.api("GET", `/api/runs/${run.id}/transcript`)).body.items;
		expect(log.map((i: { type: string }) => i.type)).toEqual(["verify_started", "verify_output", "run_finished"]);
		expect(log[1].payload.text).toContain("3 tests passed");
	});

	it("records a failing exit code as a fail with the output", async () => {
		h = await bootHarness(byStage());
		const cardId = await builtCard(h, { testCommand: 'echo "1 test failed: expected FIXED" >&2; exit 1' });
		await h.api("POST", `/api/cards/${cardId}/test`);
		const { run } = await settledTestRun(h, cardId);
		expect(run).toMatchObject({ status: "settled", resultStatus: "fail", resultSummary: "Tests exited with code 1." });
	});

	it("refuses when the project has no test command, and says where to set one", async () => {
		h = await bootHarness(byStage());
		const cardId = await builtCard(h, {});
		const refused = await h.api("POST", `/api/cards/${cardId}/test`);
		expect(refused.status).toBe(400);
		expect(refused.body.error).toContain("No test command is set");
	});

	it("refuses while a session is live for the card", async () => {
		// A planning session that never settles holds the card's one run lease.
		const hangingPlan = () => [{ hang: true, delayMs: 60_000, events: [] }];
		h = await bootHarness((spec) => (spec.sessionId.includes("-plan-") ? hangingPlan() : byStage()(spec)));
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		await h.api("PATCH", `/api/projects/${project.id}`, { testCommand: "true" });
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		const board = h.stream("board");
		await board.waitFor((f) => f.type === "card_upserted" && f.data.status === "running", 5000);

		const refused = await h.api("POST", `/api/cards/${card.id}/test`);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toContain("already running");
	});

	it("does not count test runs in usage", async () => {
		h = await bootHarness(byStage());
		// A verify command keeps the lifecycle's tester session out, so only plan + build count.
		const cardId = await builtCard(h, { verifyCommand: "true", testCommand: "true" });
		await h.api("POST", `/api/cards/${cardId}/test`);
		await settledTestRun(h, cardId);
		const usage = (await h.api("GET", "/api/usage")).body;
		// Only the planning and building sessions appear; the test run spends no tokens.
		expect(usage.byDay[0].runs).toBe(2);
	});
});

describe("hands-on: previewing a card", () => {
	it("starts, is visible in the card detail, and stops", async () => {
		h = await bootHarness(byStage());
		const cardId = await builtCard(h, { previewCommand: "sleep 60", previewUrl: "http://localhost:5173", testCommand: "true" });

		expect((await h.api("GET", `/api/cards/${cardId}`)).body.bench.preview).toMatchObject({ running: false });
		const started = await h.api("POST", `/api/cards/${cardId}/preview`);
		expect(started.status).toBe(202);
		expect(started.body).toMatchObject({ running: true, command: "sleep 60", url: "http://localhost:5173" });
		expect((await h.api("GET", `/api/cards/${cardId}`)).body.bench.preview.running).toBe(true);

		// A preview takes no run lease: the tests still run while it is up.
		expect((await h.api("POST", `/api/cards/${cardId}/test`)).status).toBe(202);
		await settledTestRun(h, cardId);

		const stopped = await h.api("DELETE", `/api/cards/${cardId}/preview`);
		expect(stopped.body).toMatchObject({ running: false });
		expect((await h.api("GET", `/api/cards/${cardId}`)).body.bench.preview.running).toBe(false);
	});

	it("refuses a second preview on the same card, and stopping when none runs", async () => {
		h = await bootHarness(byStage());
		const cardId = await builtCard(h, { previewCommand: "sleep 60" });
		await h.api("POST", `/api/cards/${cardId}/preview`);
		expect((await h.api("POST", `/api/cards/${cardId}/preview`)).status).toBe(409);
		expect((await h.api("DELETE", `/api/cards/${cardId}/preview`)).status).toBe(200);
		expect((await h.api("DELETE", `/api/cards/${cardId}/preview`)).status).toBe(409);
	});

	it("forgets previews on restart (they were the old process's children)", async () => {
		h = await bootHarness(byStage());
		const cardId = await builtCard(h, { previewCommand: "sleep 60" });
		await h.api("POST", `/api/cards/${cardId}/preview`);
		expect((await h.api("GET", `/api/cards/${cardId}`)).body.bench.preview.running).toBe(true);
		await h.restart();
		expect((await h.api("GET", `/api/cards/${cardId}`)).body.bench.preview.running).toBe(false);
	});

	it("refuses a card that has no worktree yet", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo, previewCommand: "true", testCommand: "true" })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		expect((await h.api("POST", `/api/cards/${card.id}/preview`)).status).toBe(409);
		expect((await h.api("POST", `/api/cards/${card.id}/test`)).status).toBe(409);
	});
});

describe("hands-on: the preview check", () => {
	/** Polls the card detail until the preview's check settles, then returns it. */
	async function settledCheck(harness: Harness, cardId: string) {
		for (let i = 0; i < 200; i++) {
			const preview = (await harness.api("GET", `/api/cards/${cardId}`)).body.bench.preview;
			if (preview.running && preview.check && preview.check.status !== "running") return preview;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("preview check did not settle");
	}

	it("runs the project's check after start and reports it passed", async () => {
		h = await bootHarness(byStage());
		const cardId = await builtCard(h, { previewCommand: "sleep 60", previewCheck: "echo 'preview is this app'" });
		const started = await h.api("POST", `/api/cards/${cardId}/preview`);
		expect(started.body.check).toMatchObject({ status: "running", output: null });

		const preview = await settledCheck(h, cardId);
		expect(preview.check).toMatchObject({ status: "passed", output: "preview is this app" });
	});

	it("reports a failing check as degraded, with the check's own words", async () => {
		h = await bootHarness(byStage());
		const cardId = await builtCard(h, { previewCommand: "sleep 60", previewCheck: "echo 'another app holds the port' >&2; exit 1" });
		await h.api("POST", `/api/cards/${cardId}/preview`);

		const preview = await settledCheck(h, cardId);
		// The preview still runs — it is the person's call what to do — but it no longer looks trusted.
		expect(preview.check).toMatchObject({ status: "failed" });
		expect(preview.check.output).toContain("another app holds the port");
	});

	it("stays null when no check is configured", async () => {
		h = await bootHarness(byStage());
		const cardId = await builtCard(h, { previewCommand: "sleep 60" });
		const started = await h.api("POST", `/api/cards/${cardId}/preview`);
		expect(started.body.check).toBeNull();
		expect((await h.api("DELETE", `/api/cards/${cardId}/preview`)).status).toBe(200);
	});
});
