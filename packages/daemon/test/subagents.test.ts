import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byCrew, byStage, crewPlanningTurn, integratorTurn, type FakeScript, type FakeTurn, type Harness } from "./harness.ts";
import type { RunSpec } from "@tower/core";

let h: Harness;
afterEach(async () => h?.close());

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();

/** Plans a card whose plan declares a crew, approves the plan gate, and waits for building to settle. */
async function crewCard(harness: Harness, options: { settings?: Record<string, unknown>; title?: string } = {}): Promise<{ projectId: string; cardId: string; detail: any }> {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	if (options.settings) await harness.api("PATCH", `/api/projects/${project.id}`, options.settings);
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: options.title ?? "Add retry with a crew", brief: "Make it so." })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	const gate = (await harness.api("GET", `/api/cards/${card.id}`)).body.gates.find((g: { status: string }) => g.status === "pending");
	await harness.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
	await harness.daemon.whenIdle();
	return { projectId: project.id, cardId: card.id, detail: (await harness.api("GET", `/api/cards/${card.id}`)).body };
}

/** Same, but stops at the pending plan gate so a test can hold the crew mid-flight. */
async function crewCardUpToGate(harness: Harness): Promise<{ projectId: string; cardId: string }> {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: "Add retry with a crew", brief: "Make it so." })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	return { projectId: project.id, cardId: card.id };
}

async function approveGate(harness: Harness, cardId: string): Promise<void> {
	const gate = (await harness.api("GET", `/api/cards/${cardId}`)).body.gates.find((g: { status: string }) => g.status === "pending");
	await harness.api("POST", `/api/cards/${cardId}/gates/${gate.id}`, { decision: "approve" });
}

async function waitFor(harness: Harness, ready: () => boolean): Promise<void> {
	for (let i = 0; i < 500 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(ready()).toBe(true);
}

describe("sub-agent crews", () => {
	it("fans a streamed plan out to scouts and parallel builders, then merges the streams into the card's branch", async () => {
		h = await bootHarness(byCrew());
		const { cardId, detail } = await crewCard(h);

		const ids = h.driver.handles.map((handle) => handle.sessionId);
		// Scouts and the integrator are ordered; the parallel builders race each other to the driver.
		expect(ids[0]).toBe(`c${cardId}-plan-1`);
		expect(ids[1]).toBe(`c${cardId}-crew1-scout-auth-shape`);
		expect(ids.slice(2, 4).sort()).toEqual([`c${cardId}-crew1-ws-api`, `c${cardId}-crew1-ws-docs`]);
		expect(ids[4]).toBe(`c${cardId}-crew1-integrator`);
		expect(ids[5]).toBe(`c${cardId}-test-1`);

		// Each builder worked in its own worktree on its own branch, with write access; the scout only read.
		const apiBuilder = h.driver.handles.find((handle) => handle.sessionId.endsWith("-ws-api"));
		expect(apiBuilder?.spec.cwd).toContain(`${cardId}-ws-api`);
		expect(apiBuilder?.spec.tools).toContain("edit");
		const scout = h.driver.handles.find((handle) => handle.sessionId.includes("-scout-"));
		expect(scout?.spec.tools).not.toContain("edit");
		expect(scout?.spec.tools).not.toContain("bash");

		// The card's branch holds both streams after the integrator's merges.
		const log = git(h.repo, "log", "--format=%s", detail.card.branchName);
		expect(log).toContain("Stream api");
		expect(log).toContain("Stream docs");

		// One marker row stands for the attempt; the members carry their own verdicts and spend.
		const marker = detail.runs.find((r: { model: string }) => r.model === "crew");
		expect(marker).toMatchObject({ kind: "stage", stage: "building", status: "settled", resultStatus: "pass" });
		const members = detail.runs.filter((r: { kind: string }) => r.kind === "subagent");
		expect(members.map((r: { id: string }) => r.id).sort()).toEqual([`c${cardId}-crew1-scout-auth-shape`, `c${cardId}-crew1-ws-api`, `c${cardId}-crew1-ws-docs`, `c${cardId}-crew1-integrator`].sort());
		expect(members.every((r: { tokens: { total: number } | null }) => (r.tokens?.total ?? 0) > 0)).toBe(true);

		// The scout's report and the builders' verdicts sit in the card's folder, readable from the drawer.
		expect(existsSync(join(h.home, "cards", cardId, "research", "scout-auth-shape.md"))).toBe(true);
		expect(existsSync(join(h.home, "cards", cardId, "crew", "ws-api-result.json"))).toBe(true);

		// The card carried on through testing, and the crew's spend is on the usage rollup like any session's.
		expect(detail.card.stage).toBe("feedback");
		const usage = (await h.api("GET", "/api/usage")).body;
		expect(usage.byCard.find((row: { key: string }) => row.key === cardId).tokens).toBeGreaterThan(0);
	});

	it("builds single-session when the project turns sub-agents off, whatever the plan declares", async () => {
		h = await bootHarness(byCrew());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const patched = await h.api("PATCH", `/api/projects/${project.id}`, { subagents: false });
		expect((patched.body as { subagents: boolean }).subagents).toBe(false);
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add retry with a crew", brief: "Make it so." })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		await approveGate(h, card.id);
		await h.daemon.whenIdle();
		expect(h.driver.handles.map((handle) => handle.sessionId)).toHaveLength(3);
		expect(h.driver.handles.some((handle) => handle.sessionId.includes("crew"))).toBe(false);
		// The global default is still on, and the project can go back to following it.
		expect(((await h.api("GET", "/api/settings")).body as { subagents: boolean }).subagents).toBe(true);
		const undone = await h.api("PATCH", `/api/projects/${project.id}`, { subagents: null });
		expect((undone.body as { subagents: boolean | null }).subagents).toBeNull();
	});

	it("a blocked builder stops the card for answers, and the answers drive the next crew", async () => {
		const blocked: FakeTurn = {
			events: [],
			effect: ({ prompt }: { prompt: string }) => {
				const result = prompt.match(/absolute path `([^`]+-result\.json)`/)?.[1];
				if (result) writeFileSync(result, JSON.stringify({ status: "blocked", summary: "The plan assumes an ORM the repo does not have.", questions: [{ question: "Which ORM should stream api target?", options: ["Drizzle", "Prisma"] }] }));
			},
		};
		const script: FakeScript = (spec: RunSpec) => (spec.sessionId.includes("-ws-") && spec.sessionId.includes("crew1") ? [blocked] : byCrew()(spec));
		h = await bootHarness(script);
		const { cardId } = await crewCard(h);

		const stuck = (await h.api("GET", `/api/cards/${cardId}`)).body;
		expect(stuck.card).toMatchObject({ stage: "building", status: "awaiting_input" });
		const asked = stuck.runs.findLast((r: { questions: unknown }) => r.questions);
		expect(asked?.questions?.[0]?.question).toContain("Which ORM");

		await h.api("POST", `/api/cards/${cardId}/answers`, { answers: [{ question: "Which ORM should stream api target?", answer: "Drizzle" }] });
		await h.daemon.whenIdle();

		// The crew starts over as attempt 2 — scouts included — and the members with a verdict to give
		// (builders and integrator) are told the answers; scouts ask, they are not told.
		const second = h.driver.handles.filter((handle) => handle.sessionId.includes("crew2"));
		expect(second.map((handle) => handle.sessionId).sort()).toEqual([`c${cardId}-crew2-scout-auth-shape`, `c${cardId}-crew2-ws-api`, `c${cardId}-crew2-ws-docs`, `c${cardId}-crew2-integrator`].sort());
		expect(second.filter((handle) => !handle.sessionId.includes("-scout-")).every((handle) => handle.prompts[0]?.includes("Drizzle") === true)).toBe(true);
		expect((await h.api("GET", `/api/cards/${cardId}`)).body.card.stage).toBe("feedback");
	});

	it("a plan with only scouts answers them first, then builds once with the reports in hand", async () => {
		h = await bootHarness((spec) => (spec.sessionId.includes("-plan-") ? [crewPlanningTurn("# Plan\n\n## Steps\n\n1. Add retry.ts.\n\n## Scouts\n\n- **auth-shape**: How does the middleware resolve the current user?\n")] : byCrew()(spec)));
		const { cardId } = await crewCard(h);

		expect(h.driver.handles.map((handle) => handle.sessionId)).toEqual([`c${cardId}-plan-1`, `c${cardId}-crew1-scout-auth-shape`, `c${cardId}-crew1-builder`, `c${cardId}-test-1`]);
		const builder = h.driver.handles.find((handle) => handle.sessionId.endsWith("-builder"));
		expect(builder?.prompts[0]).toContain("Research from the scouts");
		expect(builder?.prompts[0]).toContain("research/scout-auth-shape.md");
		expect((await h.api("GET", `/api/cards/${cardId}`)).body.card.stage).toBe("feedback");
	});

	it("a stream that fails stops the card with every stream's verdict on it", async () => {
		const failing: FakeTurn = {
			events: [],
			effect: ({ prompt }: { prompt: string }) => {
				const result = prompt.match(/absolute path `([^`]+-result\.json)`/)?.[1];
				if (result) writeFileSync(result, JSON.stringify({ status: "fail", summary: "The typecheck is red." }));
			},
		};
		h = await bootHarness((spec) => (spec.sessionId.includes("-ws-") ? [failing] : byCrew()(spec)));
		const { detail } = await crewCard(h);

		expect(detail.card).toMatchObject({ stage: "building", status: "needs_attention" });
		expect(detail.card.needsAttentionReason).toContain("stream api");
		expect(detail.card.needsAttentionReason).toContain("stream docs");
		// A failed crew still counts as exactly one building attempt.
		expect(detail.runs.filter((r: { kind: string; stage: string }) => r.kind === "stage" && r.stage === "building")).toHaveLength(1);
	});

	it("an integrator that hits a decision it cannot make asks, with its question on the card", async () => {
		h = await bootHarness((spec) => (spec.sessionId.includes("-integrator") ? [integratorTurn("blocked")] : byCrew()(spec)));
		const { cardId, detail } = await crewCard(h);
		expect(detail.card).toMatchObject({ stage: "building", status: "awaiting_input" });
		const asked = detail.runs.findLast((r: { questions: unknown }) => r.questions);
		expect(asked.id).toBe(`c${cardId}-crew1-integrator`);
		expect(asked.questions[0].question).toContain("retry budget");
	});

	it("aborting a crew stops every running member, and the card rests", async () => {
		const hanging: FakeTurn = { hang: true, events: [{ type: "thinking", delta: "working…" }] };
		h = await bootHarness((spec) => (spec.sessionId.includes("-ws-") ? [hanging] : byCrew()(spec)));
		const { projectId, cardId } = await crewCardUpToGate(h);
		await approveGate(h, cardId);
		await waitFor(h, () => h.driver.handles.filter((handle) => handle.sessionId.includes("-ws-")).length === 2);

		expect((await h.api("POST", `/api/cards/${cardId}/abort`)).status).toBe(200);
		await h.daemon.whenIdle();
		const detail = (await h.api("GET", `/api/cards/${cardId}`)).body;
		expect(detail.card).toMatchObject({ stage: "building", status: "idle" });
		const builders = detail.runs.filter((r: { kind: string; id: string }) => r.kind === "subagent" && r.id.includes("-ws-"));
		expect(builders.every((r: { status: string }) => r.status === "aborted")).toBe(true);
		// The stream worktrees stay for the retry to reuse; nothing is torn down behind a stopped crew.
		expect(existsSync(join(h.home, "worktrees", projectId, `${cardId}-ws-api`))).toBe(true);
	});

	it("a restart during a crew marks it interrupted, and resuming starts a fresh crew", async () => {
		const hanging: FakeTurn = { hang: true, events: [{ type: "thinking", delta: "working…" }] };
		h = await bootHarness((spec) => (spec.sessionId.includes("-ws-") ? [hanging] : byCrew()(spec)));
		const { cardId } = await crewCardUpToGate(h);
		await approveGate(h, cardId);
		await waitFor(h, () => h.driver.handles.filter((handle) => handle.sessionId.includes("-ws-")).length === 2);

		await h.restart(byCrew());
		expect((await h.api("GET", `/api/cards/${cardId}`)).body.card.status).toBe("interrupted");
		await h.api("POST", `/api/cards/${cardId}/resume`);
		await h.daemon.whenIdle();

		// The new daemon re-runs the whole crew — scouts included — as attempt 2, and carries the card on.
		expect(h.driver.handles.map((handle) => handle.sessionId).sort()).toEqual([`c${cardId}-crew2-scout-auth-shape`, `c${cardId}-crew2-ws-api`, `c${cardId}-crew2-ws-docs`, `c${cardId}-crew2-integrator`, `c${cardId}-test-1`].sort());
		expect((await h.api("GET", `/api/cards/${cardId}`)).body.card.stage).toBe("feedback");
	});

	it("an ordinary plan never crews, even with sub-agents on", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add feature", brief: "Make it so." })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		await approveGate(h, card.id);
		await h.daemon.whenIdle();
		expect(h.driver.handles.map((handle) => handle.sessionId)).toEqual([`c${card.id}-plan-1`, `c${card.id}-build-1`, `c${card.id}-test-1`]);
	});
});
