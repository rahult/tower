import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

describe("plan coach", () => {
	it("runs beside the plan gate as advice: report lands, verdict is never a lifecycle event", async () => {
		h = await bootHarness((spec) => {
			if (spec.sessionId.includes("plan-coach")) {
				return [
					{
						events: [{ type: "message", message: { role: "assistant", text: "Coached.", thinking: "", toolCalls: [] } }],
						effect: ({ prompt, spec: handle }) => {
							const report = prompt.match(/absolute path `([^`]+reviews\/[^`]+)`/)?.[1];
							if (report) {
								mkdirSync(dirname(report), { recursive: true });
								writeFileSync(report, "# What the plan doesn't answer\n\n1. **Rollback** — blocking: no way back is named.\n\nReady to build.\n");
							}
							writeFileSync(join(handle.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Ready to build." }));
						},
					},
				];
			}
			const stages = byStage()(spec);
			return spec.sessionId.includes("-plan-") ? [planningTurn()] : stages;
		}, ENV);
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });

		const res = await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "plan-coach" });
		expect(res.status).toBe(202);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		// Advice only: the decision still waits for the person.
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		expect(detail.artifacts.map((artifact: { name: string }) => artifact.name)).toContain("reviews/plan-coach.md");
		const coach = h.driver.handles.find((handle) => handle.sessionId.includes("plan-coach"));
		expect(coach?.prompts[0]).toContain("The rubric");
		expect(coach?.prompts[0]).toContain("plan.md");
		// The gate itself is untouched: no runs were consumed, the decision is still pending.
		expect(detail.gates).toHaveLength(1);
		expect(detail.gates[0]).toMatchObject({ kind: "plan_approval", status: "pending" });
	});
});

describe("a blocked hook step", () => {
	it("stops the flow: later steps do not run past a waiting question", async () => {
		// The harness step stops to ask; the red gate must NOT run past it (the red gate passing would
		// otherwise swallow the questions and open the plan gate with them dangling).
		h = await bootHarness((spec) => {
			if (spec.sessionId.includes("-plan-")) return [planningTurn()];
			if (spec.sessionId.includes("acceptance-red")) {
				if (spec.sessionId.includes("write-specs"))
					return [
						{
							events: [],
							effect: ({ spec: handle }) => {
								writeFileSync(join(handle.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "blocked", summary: "Need a decision.", questions: [{ question: "Which semantics?", options: ["A", "B"] }] }));
							},
						},
					];
				return [{ events: [] }]; // the red gate, if it ever ran, would pass
			}
			return byStage()(spec);
		}, ENV);
		// The harness needs the acceptance runner in the repository (the same fixture the gates test uses).
		writeFileSync(join(h.repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { accept: "node scripts/acceptance.mjs" } }));
		mkdirSync(join(h.repo, "scripts"), { recursive: true });
		writeFileSync(join(h.repo, "scripts", "acceptance.mjs"), "process.exit(0);\n");
		execFileSync("git", ["add", "."], { cwd: h.repo });
		execFileSync("git", ["-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "runner"], { cwd: h.repo });
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		await h.api("PATCH", `/api/projects/${project.id}`, { acceptanceGates: true });
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const stuck = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(stuck.card).toMatchObject({ stage: "planning", status: "needs_attention" });
		expect(stuck.card.needsAttentionReason).toContain("Need a decision.");
		// The red gate never ran past the question.
		expect(stuck.runs.some((run: { id: string }) => run.id.includes("red-gate"))).toBe(false);
	});
});

describe("scheduled flows", () => {
	it("a flow with the schedule trigger fires on a carrier card when its interval elapses", { timeout: 20_000 }, async () => {
		h = await bootHarness(byStage(), { ...ENV, TOWER_SCHEDULE_TICK_MS: "80" });
		homeFlow(h, "nightly-audit", { name: "nightly-audit", title: "Nightly audit", description: "", when: ["schedule"], intervalHours: 1, steps: [{ name: "go", prompt: "nightly-audit.md" }] });
		// A person's flow carries its prompt file beside it in ~/.tower/flows.
		writeFileSync(join(h.home, "flows", "nightly-audit.md"), "Audit the repository read-only. Report what has drifted.");
		const project = await addProject();

		// The boot check plus the first tick fire it; the carrier card carries the run.
		let carrier = null;
		for (let i = 0; i < 100 && !carrier; i++) {
			const board = (await h.api("GET", "/api/board")).body;
			carrier = board.cards.find((candidate: { title: string }) => candidate.title.startsWith("Scheduled: Nightly audit"));
			if (!carrier) await new Promise((resolve) => setTimeout(resolve, 60));
		}
		expect(carrier).toBeTruthy();
		await h.daemon.whenIdle();

		// The run row may lag the card by a tick; wait for it to land.
		let detail = null;
		for (let i = 0; i < 100; i++) {
			detail = (await h.api("GET", `/api/cards/${carrier.id}`)).body;
			if (detail.runs.some((run: { kind: string }) => run.kind === "flow_step")) break;
			await new Promise((resolve) => setTimeout(resolve, 60));
		}
		expect(detail.card).toMatchObject({ stage: "backlog", status: "idle", projectId: project.id });
		const runs = detail.runs.filter((run: { kind: string }) => run.kind === "flow_step");
		expect(runs.length).toBeGreaterThanOrEqual(1);
		// The state is recorded, so later ticks do not fire it again within the interval.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const board = (await h.api("GET", "/api/board")).body;
		const carriers = board.cards.filter((candidate: { title: string }) => candidate.title.startsWith("Scheduled: Nightly audit"));
		expect(carriers).toHaveLength(1);
		const stateFile = join(h.home, "projects", project.id, "schedule-state.json");
		expect(readFileSync(stateFile, "utf8")).toContain("nightly-audit");
	});

	it("a scheduled flow that needs a worktree is skipped with its reason, not fired", async () => {
		h = await bootHarness(byStage(), { ...ENV, TOWER_SCHEDULE_TICK_MS: "80" });
		homeFlow(h, "heavy-check", { name: "heavy-check", title: "Heavy check", description: "", when: ["schedule"], intervalHours: 0, steps: [{ name: "go", run: "true" }] });
		await addProject();
		await new Promise((resolve) => setTimeout(resolve, 400));
		const board = (await h.api("GET", "/api/board")).body;
		expect(board.cards.find((candidate: { title: string }) => candidate.title.startsWith("Scheduled: Heavy check"))).toBeUndefined();
	});
});

describe("answers at the feedback stage", () => {
	it("a review that stops to ask gets the person's answers as its rerun feedback", async () => {
		const DISCOVERY = { ...ENV, TOWER_REVIEW_FLOWS: undefined };
		h = await bootHarness((spec) => {
			if (spec.sessionId.includes("solid-review")) {
				if (spec.sessionId.endsWith("-1")) {
					return [
						{
							events: [],
							effect: ({ spec: handle }) => {
								writeFileSync(join(handle.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "blocked", summary: "Need the person's call.", questions: [{ question: "Is the retry budget acceptable?", options: ["Yes", "No"] }] }));
							},
						},
					];
				}
				return [
					{
						events: [{ type: "message", message: { role: "assistant", text: "Reviewed with the answer.", thinking: "", toolCalls: [] } }],
						effect: ({ prompt, spec: handle }) => {
							const report = prompt.match(/absolute path `([^`]+reviews\/[^`]+)`/)?.[1];
							if (report) {
								mkdirSync(dirname(report), { recursive: true });
								writeFileSync(report, "# Review with answers\n\nThe person decided.\n");
							}
							writeFileSync(join(handle.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Reviewed with the person's decision." }));
						},
					},
				];
			}
			const stages = byStage()(spec);
			return spec.sessionId.includes("-plan-") ? [planningTurn()] : stages;
		}, DISCOVERY);
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const gate = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.find((gate: { kind: string }) => gate.kind === "plan_approval");
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const stuck = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(stuck).toMatchObject({ stage: "feedback", status: "awaiting_input" });

		const answered = await h.api("POST", `/api/cards/${card.id}/answers`, { answers: [{ question: "Is the retry budget acceptable?", answer: "Yes — 5 attempts with jitter." }] });
		expect(answered.status).toBe(202);
		await h.daemon.whenIdle();

		const rerun = h.driver.handles.find((handle) => handle.sessionId.endsWith("solid-review-2"));
		expect(rerun?.prompts[0]).toContain("Here are the answers to your questions");
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
	});
});

describe("review fan-out", () => {
	it("a project can run its reviews at the same time", async () => {
		h = await bootHarness(byStage(), ENV);
		// Deterministic steps: the slow one holds its "running" row long enough to prove the overlap.
		homeFlow(h, "slowreview", { name: "slowreview", title: "Slow review", description: "", when: ["after-tests"], steps: [{ name: "go", run: "sleep 0.6" }] });
		homeFlow(h, "fastreview", { name: "fastreview", title: "Fast review", description: "", when: ["after-tests"], steps: [{ name: "go", run: "true" }] });
		const project = await addProject();
		const patched = await h.api("PATCH", `/api/projects/${project.id}`, { reviewFlows: ["slowreview", "fastreview"], parallelReviews: true });
		console.log("PATCH:", patched.status, JSON.stringify({ reviewFlows: patched.body.reviewFlows, parallelReviews: patched.body.parallelReviews }));
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const planGate = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.find((gate: { kind: string }) => gate.kind === "plan_approval");
		await h.api("POST", `/api/cards/${card.id}/gates/${planGate.id}`, { decision: "approve" });

		// The proof of overlap: the fast review settles while the slow one is still on the wall.
		let overlapped = false;
		for (let i = 0; i < 60 && !overlapped; i++) {
			const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
			const steps = detail.runs.filter((run: { kind: string }) => run.kind === "flow_step");
			overlapped = steps.some((run: { status: string }) => run.status === "settled") && steps.some((run: { status: string }) => run.status === "running");
			if (!overlapped) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(overlapped).toBe(true);

		await h.daemon.whenIdle();
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		const steps = detail.runs.filter((run: { kind: string }) => run.kind === "flow_step");
		expect(steps).toHaveLength(2);
		expect(steps.every((run: { resultStatus: string }) => run.resultStatus === "pass")).toBe(true);
	});
});

describe("deep research", () => {
	it("runs on a backlog card in the project checkout, before any work starts", async () => {
		h = await bootHarness(researchScript(""), ENV);
		homeFlow(h, "writey", { name: "writey", title: "Writes", description: "", when: ["manual"], steps: [{ name: "go", run: "true" }] });
		const project = await addProject();
		// The project's source tray: research reads these before it searches the network.
		const pinned = await h.api("PATCH", `/api/projects/${project.id}`, { sources: ["docs/decisions.md", "https://internal.example.com/architecture"] });
		expect(pinned.status).toBe(200);
		expect(pinned.body.sources).toEqual(["docs/decisions.md", "https://internal.example.com/architecture"]);
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
		// The tray reached the survey agent; a project with no tray renders no section at all.
		const survey = h.driver.handles.find((handle) => handle.sessionId.includes("deep-research-survey"));
		expect(survey?.prompts[0]).toContain("Pinned sources");
		expect(survey?.prompts[0]).toContain("docs/decisions.md");
		expect(survey?.prompts[0]).not.toMatch(/\{\{/);
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

describe("live probes", () => {
	it("a probe step writes and runs spike code in a throwaway directory, not the worktree", async () => {
		h = await bootHarness((spec) => {
			if (spec.sessionId.includes("spikey"))
				return [
					{
						events: [{ type: "message", message: { role: "assistant", text: "Spike written and run.", thinking: "", toolCalls: [] } }],
						effect: ({ spec, prompt }) => {
							// The spike lands in whatever directory the session was handed; the report and
							// result go where the prompt points, like any flow step.
							writeFileSync(join(spec.cwd, "spike.mjs"), "console.log('candidate A boots in 3ms');");
							probeCwd = spec.cwd;
							probeTools = spec.tools;
							const report = prompt.match(/absolute path `([^`]+)`/)?.[1];
							if (report) writeFileSync(report, "# Spike\n\nCandidate A boots in 3ms.");
							writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Spike run." }));
						},
					},
				];
			return byStage()(spec);
		}, ENV);
		let probeCwd: string | undefined;
		let probeTools: string[] | undefined;
		// The person's own flow, with a probe step: the prompt file sits beside the flow in ~/.tower/flows.
		homeFlow(h, "spikey", { name: "spikey", title: "Spike", description: "", when: ["manual"], steps: [{ name: "run", prompt: "spikey.md", access: "probe", model: "testing", thinking: "low" }] });
		writeFileSync(join(h.home, "flows", "spikey.md"), "Write a spike under this directory and run it. Write your findings to the absolute path `{{reportPath}}`.");

		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		// The card rests at its plan gate — a probe works even before a worktree exists.
		const res = await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "spikey" });
		expect(res.status).toBe(202);
		await h.daemon.whenIdle();

		// The spike ran in the card's probe directory, with full tools, never in a worktree.
		expect(probeCwd).toBe(join(h.home, "cards", card.id, "probe"));
		expect(existsSync(join(probeCwd as string, "spike.mjs"))).toBe(true);
		expect(probeTools).toContain("edit");
		expect(probeTools).toContain("bash");
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		expect(detail.artifacts.map((artifact: { name: string }) => artifact.name)).toContain("reviews/spikey.md");
	});
});

describe("invariant diff check", () => {
	it("judges a built card's diff against the plan's invariants on the cheap tier", async () => {
		// The scripted check reads its own prompt, writes a violated report, and fails — the way the real
		// agent would when the diff breaks a plan invariant.
		let captured: { cwd: string; model: string; prompt: string } | undefined;
		h = await bootHarness((spec) => {
			if (spec.sessionId.includes("invariant-diff"))
				return [
					{
						events: [{ type: "message", message: { role: "assistant", text: "Diff checked.", thinking: "", toolCalls: [] } }],
						effect: ({ spec, prompt }) => {
							captured = { cwd: spec.cwd, model: spec.model, prompt };
							const report = prompt.match(/absolute path `([^`]+reviews\/[^`]+)`/)?.[1];
							if (report) writeFileSync(report, "# Invariant diff\n\nViolated: 1\n");
							writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "fail", summary: "Violated: 1" }));
						},
					},
				];
			return byStage()(spec);
		}, ENV);
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		await approvePlanGate(card.id);
		const built = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(built.worktreePath).toBeTruthy();

		const res = await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "invariant-diff" });
		expect(res.status).toBe(202);
		await h.daemon.whenIdle();

		expect(captured?.cwd).toBe(built.worktreePath);
		expect(captured?.model).not.toBe("anthropic/claude-fable-5-1"); // the cheap tier, not the planner's
		expect(captured?.prompt).toContain("Do not re-derive the model");
		expect(captured?.prompt).toContain(`cards/${built.id}/plan.md`);
		expect(captured?.prompt).toContain("..HEAD");
		expect(captured?.prompt).not.toMatch(/\{\{/);
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.artifacts.map((artifact: { name: string }) => artifact.name)).toContain("reviews/invariant-diff.md");
		// The fail verdict is the run's verdict — as an after-build hook this is what gates testing.
		const check = detail.runs.find((run: { id: string }) => run.id.startsWith(`c${card.id}-invariant-diff-`));
		expect(check).toMatchObject({ resultStatus: "fail", resultSummary: "Violated: 1" });
	});
});
