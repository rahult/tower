import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STAGE_RESULT_FILE } from "@tower/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseFlow } from "../src/flows.ts";
import { byStage, bootHarness, type FakeScript, type FakeTurn, type Harness, planningTurn, reviewTurn } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

/** The person's own flow, dropped into <home>/flows the way a real one is. */
function homeFlow(harness: Harness, name: string, flow: Record<string, unknown>): void {
	const dir = join(harness.home, "flows");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.flow.json`), JSON.stringify(flow));
}

async function addProject(): Promise<{ id: string }> {
	return (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
}

async function addCard(projectId: string): Promise<{ id: string }> {
	return (await h.api("POST", "/api/cards", { projectId, title: "Add retry with backoff", brief: "5xx responses should be retried." })).body;
}

/** The plan gate the policy opens for a plan this size; without approving it nothing ever builds. */
async function approvePlanGate(cardId: string): Promise<void> {
	const detail = (await h.api("GET", `/api/cards/${cardId}`)).body;
	const gate = detail.gates.find((gate: { status: string }) => gate.status === "pending");
	if (gate) await h.api("POST", `/api/cards/${cardId}/gates/${gate.id}`, { decision: "approve", feedback: "" });
	await h.daemon.whenIdle();
}

describe("designing your own flows", () => {
	it("validates steps and triggers", () => {
		expect(() => parseFlow('{"name":"x","steps":[{"name":"a","run":"true","prompt":"x.md"}]}', "t")).toThrow("exactly one of");
		expect(() => parseFlow('{"name":"x","when":["someday"],"steps":[{"name":"a","run":"true"}]}', "t")).toThrow('"when"');
		expect(() => parseFlow('{"name":"x","steps":[{"name":"a","run":"true","expect":"maybe"}]}', "t")).toThrow("expect");
		expect(() => parseFlow('{"name":"x","steps":[{"name":"a","run":"true","timeoutSec":0}]}', "t")).toThrow("timeoutSec");
		// Unset triggers mean manual, so every existing flow file keeps meaning what it meant.
		expect(parseFlow('{"name":"x","steps":[{"name":"a","run":"true"}]}', "t").when).toEqual(["manual"]);
	});

	it("an after-build gate stops the card when its command fails, and retrying rebuilds with the gate's output", async () => {
		h = await bootHarness(byStage(), ENV);
		homeFlow(h, "size-gate", {
			name: "size-gate",
			title: "Size gate",
			description: "The bundle must not ship without its marker.",
			when: ["after-build"],
			steps: [{ name: "check", run: "test -f {{worktreePath}}/gate.txt || { echo 'gate.txt is missing'; exit 7; }" }],
		});
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		await approvePlanGate(card.id);
		// The build passed, the gate did not: the card stops in testing with the step's own words.
		const stuck = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(stuck.card).toMatchObject({ stage: "testing", status: "needs_attention" });
		expect(stuck.card.needsAttentionReason).toContain("The after-build flows did not pass");
		expect(stuck.card.needsAttentionReason).toContain("gate.txt is missing");
		const gate = stuck.runs.find((run: { id: string }) => run.id.includes("size-gate"));
		expect(gate).toMatchObject({ kind: "flow_step", resultStatus: "fail" });
		expect(gate.resultSummary).toContain("exited with code 7");

		// Retry: a failed gate is repaired by rebuilding, and the builder is told what the gate said.
		writeFileSync(join(stuck.card.worktreePath, "gate.txt"), "unlocked\n");
		await h.api("POST", `/api/cards/${card.id}/retry`);
		await h.daemon.whenIdle();
		const rebuild = h.driver.handles.find((handle) => handle.sessionId.endsWith("-build-2"));
		expect(rebuild?.prompts[0]).toContain("The after-build flows did not pass");

		const done = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(done.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		expect(done.runs.find((run: { id: string }) => run.id.endsWith("-size-gate-2"))).toMatchObject({ resultStatus: "pass" });
	});

	it("an informational step records its output but never fails the flow", async () => {
		h = await bootHarness(byStage(), ENV);
		homeFlow(h, "audit-note", {
			name: "audit-note",
			title: "Audit note",
			description: "Counts things for the record.",
			when: ["after-build"],
			steps: [{ name: "count", run: "echo 3 files changed", expect: "note" }],
		});
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		await approvePlanGate(card.id);
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		// A note cannot stop the lifecycle: the card went straight through to the feedback gate.
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		const note = detail.runs.find((run: { id: string }) => run.id.includes("audit-note"));
		expect(note).toMatchObject({ kind: "flow_step", resultStatus: "pass" });
		expect(note.resultSummary).toContain("Recorded, exit 0");
	});

	it("a passing plan runs its after-plan hooks before the plan gate", async () => {
		const script: FakeScript = (spec) => {
			if (spec.sessionId.includes("plan-critique")) return [reviewTurn()];
			return byStage()(spec);
		};
		h = await bootHarness(script, ENV);
		homeFlow(h, "plan-critique", {
			name: "plan-critique",
			title: "Plan critique",
			description: "A second opinion on the plan before the human approves it.",
			when: ["after-plan"],
			steps: [{ name: "critique", prompt: "adversarial-review.md", model: "planning", access: "read-only" }],
		});
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		const critique = detail.runs.find((run: { id: string }) => run.id.includes("plan-critique"));
		expect(critique).toMatchObject({ kind: "flow_step", stage: "planning" });
	});

	it("unset review flows are discovered from the after-tests trigger, in file order", async () => {
		h = await bootHarness(byStage(), { ...ENV, TOWER_REVIEW_FLOWS: undefined });
		homeFlow(h, "extra-review", { name: "extra-review", title: "Extra review", description: "", when: ["manual", "after-tests"], steps: [{ name: "look", run: "true" }] });
		const listed = (await h.api("GET", "/api/flows")).body;
		expect(listed.defaults).toEqual(["adversarial-review", "solid-review", "extra-review"]);

		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		await approvePlanGate(card.id);
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		// The deterministic review ran alongside the agent reviews, and the card still reached the human.
		const labels = detail.runs.filter((run: { kind: string }) => run.kind === "flow_step").map((run: { id: string }) => run.id.replace(`c${card.id}-`, "").replace(/-\d+$/, ""));
		expect(labels).toEqual(["adversarial-review", "solid-review", "extra-review"]);
	});
});

/** A scripted research step: writes its report where the prompt points and reports a pass. */
function researchTurn(label: string): FakeTurn {
	return {
		events: [{ type: "message", message: { role: "assistant", text: `${label} written.`, thinking: "", toolCalls: [] } }],
		effect: ({ spec, prompt }) => {
			const report = prompt.match(/absolute path `([^`]+reviews\/[^`]+)`/)?.[1];
			if (report) {
				mkdirSync(dirname(report), { recursive: true });
				writeFileSync(report, `# ${label}\n\n## Findings\n\n- Something sourced from https://example.com\n`);
			}
			writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: `${label} ready.` }));
		},
	};
}

function researchScript(intentReply: string): FakeScript {
	return (spec) => {
		if (spec.sessionId.includes("assist")) return [{ events: [{ type: "message", message: { role: "assistant", text: intentReply, thinking: "", toolCalls: [] } }] }];
		if (spec.sessionId.includes("deep-research-survey")) return [researchTurn("Survey")];
		if (spec.sessionId.includes("deep-research-synthesize")) return [researchTurn("Brief")];
		const stages = byStage()(spec);
		return spec.sessionId.includes("-plan-") ? [planningTurn()] : stages;
	};
}

describe("deep research", () => {
	it("runs on a backlog card in the project checkout, before any work starts", async () => {
		h = await bootHarness(researchScript(""), ENV);
		homeFlow(h, "writey", { name: "writey", title: "Writes", description: "", when: ["manual"], steps: [{ name: "go", run: "true" }] });
		const project = await addProject();
		const card = await addCard(project.id);

		// The shipped flow is read-only, so it needs no worktree — it explores in the checkout itself.
		const res = await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "deep-research" });
		expect(res.status).toBe(202);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "backlog", status: "idle" });
		const labels = detail.runs.filter((run: { kind: string }) => run.kind === "flow_step").map((run: { id: string }) => run.id.replace(`c${card.id}-`, "").replace(/-\d+$/, ""));
		expect(labels).toEqual(["deep-research-survey", "deep-research-synthesize"]);
		for (const suffix of ["deep-research-survey", "deep-research-synthesize"]) {
			expect(h.driver.handles.find((handle) => handle.sessionId.includes(suffix))?.spec.cwd).toBe(h.repo);
		}
		expect(detail.artifacts.map((artifact: { name: string }) => artifact.name)).toContain("reviews/deep-research-synthesize.md");

		// A flow that runs commands needs the worktree — a backlog card refuses it.
		const refused = await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "writey" });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toContain("only read-only flows");
	});

	it("the ask box turns an exploring line into a researched card, and the planner reads the brief", async () => {
		h = await bootHarness(
			researchScript('{"action":"research_card","project":"","title":"Local-first sync engines","brief":"What fits a small notes app?"}'),
			ENV,
		);
		const project = await addProject();
		await h.api("PATCH", `/api/projects/${project.id}`, { name: "remembero" });
		const res = await h.api("POST", "/api/assist", { text: "research local-first sync engines @remembero" });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, action: "research_card", projectId: project.id, card: { title: "Local-first sync engines" } });
		expect(res.body.reply).toContain("Researching");
		await h.daemon.whenIdle();

		// The brief exists, and the planner that follows is pointed straight at it.
		const card = res.body.card;
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.artifacts.map((artifact: { name: string }) => artifact.name)).toContain("reviews/deep-research-synthesize.md");
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const planner = h.driver.handles.find((handle) => handle.sessionId.endsWith("-plan-1"));
		expect(planner?.prompts[0]).toContain("deep-research-synthesize.md");
		expect(planner?.prompts[0]).toContain("Research brief");
	});
});
