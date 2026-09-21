import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFlow } from "../src/flows.ts";
import { bootHarness, byStage, type Harness, planningTurn } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
	delete process.env.PI_CODING_AGENT_DIR;
});

async function plannedCard(harness: Harness) {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: "Add feature" })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	return card;
}

describe("ad hoc runs", () => {
	it("runs a prompt with a chosen model against a resting card without moving it", async () => {
		h = await bootHarness(byStage());
		const card = await plannedCard(h);
		const started = await h.api("POST", `/api/cards/${card.id}/adhoc`, { prompt: "List the riskiest files.", model: "kimi-coding/k3", thinking: "low", access: "read-only" });
		expect(started.status).toBe(202);
		expect(started.body.run).toMatchObject({ id: `c${card.id}-adhoc-1`, kind: "adhoc", model: "kimi-coding/k3", thinking: "low" });
		await h.daemon.whenIdle();

		const session = h.driver.handles.at(-1);
		expect(session?.prompts).toEqual(["List the riskiest files."]);
		expect(session?.spec.tools).not.toContain("edit");
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		expect(detail.runs.at(-1)).toMatchObject({ kind: "adhoc", status: "settled" });
	});

	it("runs a pi skill by name and a review flow on demand", async () => {
		h = await bootHarness(byStage());
		const card = await plannedCard(h);
		await h.api("POST", `/api/cards/${card.id}/adhoc`, { skill: "grilling", task: "the plan" });
		await h.daemon.whenIdle();
		expect(h.driver.handles.at(-1)?.prompts[0]).toBe("/skill:grilling the plan");

		await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "solid-review" });
		await h.daemon.whenIdle();
		expect(h.driver.handles.at(-1)?.sessionId).toBe(`c${card.id}-solid-review-1`);
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.artifacts.map((a: { name: string }) => a.name)).toContain("reviews/solid-review.md");
	});

	it("runs one of the person's pi agent roles with its model, tools and system prompt", async () => {
		h = await bootHarness(byStage());
		const agents = join(h.home, "..", "pi-agent", "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(join(agents, "reviewer.md"), "---\nname: reviewer\nmodel: openai-codex/gpt-6-astra\ntools: read, bash\nthinking: medium\n---\nYou review code. You never fix it.\n");
		process.env.PI_CODING_AGENT_DIR = join(h.home, "..", "pi-agent");
		const card = await plannedCard(h);
		await h.api("POST", `/api/cards/${card.id}/adhoc`, { agent: "reviewer", task: "Review the plan." });
		await h.daemon.whenIdle();
		const session = h.driver.handles.at(-1);
		expect(session?.spec).toMatchObject({ model: "openai-codex/gpt-6-astra", thinking: "medium", tools: ["read", "bash"] });
		expect(session?.spec.appendSystemPromptFiles[0]).toContain("roles/reviewer.md");
		expect(session?.prompts[0]).toBe("Review the plan.");
		expect((await h.api("POST", `/api/cards/${card.id}/adhoc`, { agent: "nobody" })).status).toBe(400);
	});

	it("refuses when the request is unclear, the card is busy, or it has no worktree", async () => {
		h = await bootHarness(() => [planningTurn({ delayMs: 60 })]);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		expect((await h.api("POST", `/api/cards/${card.id}/adhoc`, { prompt: "hi" })).status).toBe(409);
		expect((await h.api("POST", `/api/cards/${card.id}/adhoc`, {})).status).toBe(400);
		expect((await h.api("POST", `/api/cards/${card.id}/adhoc`, { prompt: "a", skill: "b" })).status).toBe(400);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect((await h.api("POST", `/api/cards/${card.id}/adhoc`, { prompt: "hi" })).status).toBe(409);
		await h.daemon.whenIdle();
	});
});

describe("usage", () => {
	it("rolls tokens and cost up by card, project, model and day", async () => {
		h = await bootHarness(byStage());
		const card = await plannedCard(h);
		const usage = (await h.api("GET", "/api/usage")).body;
		expect(usage.byCard).toEqual([{ key: card.id, runs: 1, tokens: 120, costUsd: 0.001 }]);
		expect(usage.byModel[0]).toMatchObject({ key: "anthropic/claude-fable-5-1", tokens: 120 });
		expect(usage.byDay).toHaveLength(1);
		expect(usage.byProject[0].key).toBe(card.projectId);
	});
});

describe("questions from a pi extension", () => {
	const asks = { events: [{ type: "ui_request" as const, id: "ui-1", method: "confirm", blocking: true, payload: { title: "Run the migration?" } }], hang: true };

	it("can be answered from the board while the session waits", async () => {
		h = await bootHarness(() => [asks]);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		const run = h.stream(`run:c${card.id}-plan-1`);
		await run.waitFor((frame) => frame.type === "ui_request");
		expect((await h.api("POST", `/api/runs/c${card.id}-plan-1/ui/ui-1`, { confirmed: true })).status).toBe(200);
		expect(h.driver.handles[0]?.uiAnswers).toEqual([{ requestId: "ui-1", answer: { confirmed: true } }]);
		await run.waitFor((frame) => frame.type === "ui_resolved" && frame.data.payload.outcome === "answered");
		expect((await h.api("POST", `/api/runs/c${card.id}-plan-1/ui/ui-1`, { confirmed: true })).status).toBe(409);
		await h.api("POST", `/api/cards/${card.id}/abort`);
	});

	it("is cancelled when nobody answers in time, so the agent is never stuck forever", async () => {
		h = await bootHarness(() => [asks], { TOWER_UI_REQUEST_TIMEOUT_MS: "40" });
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		const run = h.stream(`run:c${card.id}-plan-1`);
		await run.waitFor((frame) => frame.type === "ui_resolved" && frame.data.payload.outcome === "expired");
		expect(h.driver.handles[0]?.uiAnswers).toEqual([{ requestId: "ui-1", answer: { cancelled: true } }]);
		await h.api("POST", `/api/cards/${card.id}/abort`);
	});
});

describe("parseFlow", () => {
	it("accepts a well-formed flow", () => {
		expect(parseFlow('{"name":"sec","steps":[{"name":"scan","skill":"security-review"}]}', "sec.flow.json")).toMatchObject({ name: "sec", title: "sec" });
	});
	it.each([
		["not json", "not valid JSON"],
		['{"name":"Bad Name","steps":[{"name":"a","prompt":"x.md"}]}', "lower-case"],
		['{"name":"x","steps":[]}', "at least one step"],
		['{"name":"x","steps":[{"name":"a","prompt":"p.md","skill":"s"}]}', "exactly one of"],
		['{"name":"x","steps":[{"name":"a","prompt":"p.md","access":"root"}]}', "unknown access"],
	])("rejects %s", (text, hint) => expect(() => parseFlow(text, "x.flow.json")).toThrow(hint));
});
