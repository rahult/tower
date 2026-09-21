import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_RESULT_FILE } from "@traffic-control/core";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness, planningTurn } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

async function seedCard(harness: Harness, title = "Add a README section") {
	const project = await harness.api("POST", "/api/projects", { repoPath: harness.repo });
	expect(project.status).toBe(201);
	const card = await harness.api("POST", "/api/cards", { projectId: project.body.id, title, brief: "Explain setup." });
	expect(card.status).toBe(201);
	return { project: project.body, card: card.body };
}

async function runToCompletion(harness: Harness, cardId: string) {
	const started = await harness.api("POST", `/api/cards/${cardId}/run`, {});
	expect(started.status).toBe(202);
	await harness.daemon.stages.inFlight.get(started.body.id);
	return started.body;
}

describe("planning stage through the HTTP surface", () => {
	it("runs planning in a dedicated worktree and records a passing result", async () => {
		h = await bootHarness(() => [planningTurn()]);
		const { project, card } = await seedCard(h);
		expect(project).toMatchObject({ name: "repo", defaultBranch: "main", trustProjectPi: false });

		const board = h.stream("board");
		const run = await runToCompletion(h, card.id);
		expect(run).toMatchObject({ id: `c${card.id}-plan-1`, stage: "planning", model: "anthropic/claude-fable-5-1", thinking: "high" });
		expect(run.args).toContain("--no-extensions");
		expect(run.args).toContain("--no-approve");

		const detail = await h.api("GET", `/api/cards/${card.id}`);
		expect(detail.body.card).toMatchObject({ stage: "planning", status: "idle", attempt: 1, branchName: `tc/${card.id}-add-a-readme-section` });
		expect(existsSync(join(detail.body.card.worktreePath, "README.md"))).toBe(true);
		expect(detail.body.runs[0]).toMatchObject({ status: "settled", resultStatus: "pass", resultSummary: "Plan ready.", tokens: { total: 120 }, lastEntryId: "entry-1" });
		expect(detail.body.artifacts.map((a: { name: string }) => a.name).sort()).toEqual(["plan.md", STAGE_RESULT_FILE]);
		expect((await h.api("GET", `/api/cards/${card.id}/artifacts/plan.md`)).body).toContain("Do the thing");

		// The session ran in the worktree, not the user's checkout, and saw only the rendered prompt.
		const handle = h.driver.handles[0];
		expect(handle?.spec.cwd).toBe(detail.body.card.worktreePath);
		expect(handle?.prompts[0]).toContain("Add a README section");
		expect(handle?.prompts[0]).toContain(join(h.home, "cards", card.id, "plan.md"));
		expect(handle?.stopped).toBe(true);

		await board.waitFor((f) => f.type === "card_upserted" && f.data.status === "idle" && f.data.stage === "planning");
	});

	it("streams the transcript live and replays it exactly for a finished run", async () => {
		h = await bootHarness(() => [planningTurn({ delayMs: 5 })]);
		const { card } = await seedCard(h);
		const runId = `c${card.id}-plan-1`;
		const live = h.stream(`run:${runId}`);
		await runToCompletion(h, card.id);
		await live.waitFor((f) => f.type === "run_finished");

		const types = live.frames.map((f) => f.type);
		expect(types).toEqual(expect.arrayContaining(["prompt", "thinking", "tool_start", "tool_end", "text", "message", "settled", "run_finished"]));
		const seqs = live.frames.map((f) => f.data.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(live.frames.every((f) => f.id === `run:${runId}:${f.data.seq}`)).toBe(true);

		// Cold replay: anchors only (no deltas), same seq numbers, authoritative message present.
		const cold = await h.api("GET", `/api/runs/${runId}/transcript`);
		expect(cold.body.live).toBe(false);
		const coldTypes = cold.body.items.map((i: { type: string }) => i.type);
		expect(coldTypes).not.toContain("text");
		expect(coldTypes).not.toContain("thinking");
		expect(cold.body.items.find((i: { type: string }) => i.type === "message").payload.message.text).toBe("Plan written.");
		const liveBySeq = new Map(live.frames.map((f) => [f.data.seq, f.type]));
		for (const item of cold.body.items) expect(liveBySeq.get(item.seq)).toBe(item.type);
	});

	it("replays missed items to a tab that opens mid-run, with no gaps or duplicates", async () => {
		h = await bootHarness(() => [planningTurn({ delayMs: 40 })]);
		const { card } = await seedCard(h);
		const runId = `c${card.id}-plan-1`;
		const started = await h.api("POST", `/api/cards/${card.id}/run`, {});
		const first = h.stream(`run:${runId}`);
		await first.waitFor((f) => f.type === "tool_start");

		const late = h.stream(`run:${runId}`);
		await h.daemon.stages.inFlight.get(started.body.id);
		await late.waitFor((f) => f.type === "run_finished");
		await first.waitFor((f) => f.type === "run_finished");
		expect(late.frames.map((f) => f.data.seq)).toEqual(first.frames.map((f) => f.data.seq));

		// Reconnect with Last-Event-ID: only what came after.
		const cursor = first.frames[2]?.id as string;
		const resumed = h.stream(`run:${runId}`, { lastEventId: cursor });
		await resumed.waitFor((f) => f.type === "run_finished");
		expect(resumed.frames[0]?.data.seq).toBeGreaterThan(first.frames[2]?.data.seq);
	});

	it("nudges once when the result file is missing, then asks for attention", async () => {
		h = await bootHarness(() => [planningTurn({ writeResult: false }), { events: [] }]);
		const { card } = await seedCard(h);
		await runToCompletion(h, card.id);

		expect(h.driver.handles[0]?.prompts).toHaveLength(2);
		expect(h.driver.handles[0]?.prompts[1]).toContain(STAGE_RESULT_FILE);
		const detail = await h.api("GET", `/api/cards/${card.id}`);
		expect(detail.body.card).toMatchObject({ status: "needs_attention", needsAttentionReason: "stage-result.json was not written" });
		expect(detail.body.runs[0]).toMatchObject({ status: "settled", resultStatus: "missing" });
	});

	it("accepts the result when the nudge works", async () => {
		h = await bootHarness((spec) => [
			planningTurn({ writeResult: false }),
			{ events: [], effect: () => writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), '{"status":"pass","summary":"late"}') },
		]);
		const { card } = await seedCard(h);
		await runToCompletion(h, card.id);
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.runs[0]).toMatchObject({ resultStatus: "pass", resultSummary: "late" });
	});

	it("surfaces a blocked stage as needing attention, with the agent's question", async () => {
		h = await bootHarness((spec) => [
			{ events: [], effect: () => writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), '{"status":"blocked","summary":"Which database?"}') },
		]);
		const { card } = await seedCard(h);
		await runToCompletion(h, card.id);
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ status: "needs_attention", needsAttentionReason: "blocked: Which database?" });
	});

	it("steers a running session and records the steer in the transcript", async () => {
		h = await bootHarness(() => [planningTurn({ delayMs: 40 })]);
		const { card } = await seedCard(h);
		const started = await h.api("POST", `/api/cards/${card.id}/run`, {});
		expect((await h.api("POST", `/api/cards/${card.id}/steer`, { text: "Keep it short." })).status).toBe(200);
		await h.daemon.stages.inFlight.get(started.body.id);

		expect(h.driver.handles[0]?.steers).toEqual(["Keep it short."]);
		const cold = await h.api("GET", `/api/runs/${started.body.id}/transcript`);
		expect(cold.body.items.some((i: { type: string; payload: { text: string } }) => i.type === "steer" && i.payload.text === "Keep it short.")).toBe(true);
	});

	it("aborts a running session and frees the card for another run", async () => {
		h = await bootHarness(() => [planningTurn({ delayMs: 100 })]);
		const { card } = await seedCard(h);
		await h.api("POST", `/api/cards/${card.id}/run`, {});
		expect((await h.api("POST", `/api/cards/${card.id}/run`, {})).status).toBe(409);
		expect((await h.api("POST", `/api/cards/${card.id}/abort`)).status).toBe(200);

		const detail = await h.api("GET", `/api/cards/${card.id}`);
		expect(detail.body.card.status).toBe("idle");
		expect(detail.body.runs[0].status).toBe("aborted");

		const again = await h.api("POST", `/api/cards/${card.id}/run`, {});
		expect(again.status).toBe(202);
		expect(again.body.id).toBe(`c${card.id}-plan-2`);
		await h.daemon.stages.inFlight.get(again.body.id);
	});

	it("validates input and rejects actions that make no sense", async () => {
		h = await bootHarness(() => []);
		expect((await h.api("POST", "/api/projects", { repoPath: h.home })).status).toBe(400);
		expect((await h.api("POST", "/api/projects", {})).status).toBe(400);
		const { project, card } = await seedCard(h);
		expect((await h.api("POST", "/api/projects", { repoPath: h.repo })).status).toBe(409);
		expect((await h.api("POST", "/api/cards", { projectId: project.id })).status).toBe(400);
		expect((await h.api("POST", "/api/cards", { projectId: "nope", title: "x" })).status).toBe(404);
		expect((await h.api("POST", `/api/cards/${card.id}/steer`, { text: "hi" })).status).toBe(409);
		expect((await h.api("GET", `/api/cards/${card.id}/artifacts/..%2F..%2Ftc.sqlite`)).status).toBe(404);
		expect((await h.api("GET", "/api/cards/missing")).status).toBe(404);
	});
});
