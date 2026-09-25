import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STAGE_RESULT_FILE } from "@tower/core";
import { bootHarness, planningTurn, testerTurn, reviewTurn, type FakeScript, type FakeTurn, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

/** The acceptance runner a fixture repository ships: same exit-code contract as the archetype's. */
const RUNNER = `
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const specsDir = join(root, "acceptance", "specs");
const expectRed = process.argv.includes("--expect-red");
const files = readdirSync(specsDir).filter((file) => file.endsWith(".mjs")).sort();
if (files.length === 0) { console.error("no acceptance specs"); process.exit(1); }
const results = [];
for (const file of files) {
	try {
		const mod = await import(pathToFileURL(join(specsDir, file)).href);
		await mod.run({ baseUrl: "unused" });
		results.push({ file, ok: true });
	} catch (error) {
		results.push({ file, ok: false, why: String(error?.message ?? error) });
	}
}
for (const result of results) console.log(result.ok ? "PASS" : "FAIL", result.file, result.ok ? "" : result.why);
const failed = results.filter((result) => !result.ok).length;
process.exit(expectRed ? (failed === results.length ? 0 : 1) : (failed === 0 ? 0 : 1));
`;

/** Installs package.json + the runner into the harness repository and commits them. */
function installAcceptanceRunner(harness: Harness): void {
	writeFileSync(join(harness.repo, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { accept: "node scripts/acceptance.mjs" } }));
	mkdirSync(join(harness.repo, "scripts"), { recursive: true });
	writeFileSync(join(harness.repo, "scripts", "acceptance.mjs"), RUNNER.trimStart());
	execFileSync("git", ["add", "."], { cwd: harness.repo });
	execFileSync("git", ["-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "acceptance runner"], { cwd: harness.repo });
}

const SPEC = {
	red: "export const name = 'generated';\nexport async function run() { throw new Error('not built yet'); }\n",
	green: "export const name = 'generated';\nexport async function run() { /* the behavior exists now */ }\n",
};

/** The harness step that turns the plan's test targets into specs — red, or wrongly green when asked. */
function harnessTurn(specWorks: boolean): FakeTurn {
	return {
		events: [{ type: "message", message: { role: "assistant", text: "Specs written.", thinking: "", toolCalls: [] } }],
		effect: ({ spec }) => {
			const specs = join(spec.cwd, "acceptance", "specs");
			mkdirSync(specs, { recursive: true });
			writeFileSync(join(specs, "generated.mjs"), specWorks ? SPEC.green : SPEC.red);
			writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "1 acceptance spec written." }));
		},
	};
}

/** The builder that makes the specs green and commits the work. */
function greenBuilderTurn(): FakeTurn {
	return {
		events: [{ type: "message", message: { role: "assistant", text: "Implemented.", thinking: "", toolCalls: [] } }],
		effect: ({ spec }) => {
			writeFileSync(join(spec.cwd, "acceptance", "specs", "generated.mjs"), SPEC.green);
			writeFileSync(join(spec.cwd, "feature.txt"), "the behavior\n");
			execFileSync("git", ["add", "."], { cwd: spec.cwd });
			execFileSync("git", ["-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "Build the feature"], { cwd: spec.cwd });
			writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Built; acceptance green." }));
		},
	};
}

function script(options: { specsWork: boolean; builderTurn?: () => FakeTurn } = { specsWork: false }): FakeScript {
	return (spec) => {
		if (spec.sessionId.includes("-plan-")) return [planningTurn()];
		if (spec.sessionId.includes("acceptance-red")) return [harnessTurn(options.specsWork)];
		if (spec.sessionId.includes("-build-") || spec.sessionId.includes("-cifix-")) return [options.builderTurn?.() ?? greenBuilderTurn()];
		if (spec.sessionId.includes("-test-")) return [testerTurn()];
		return [reviewTurn()];
	};
}

const addProject = async (): Promise<{ id: string }> => (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
const addCard = async (projectId: string): Promise<{ id: string }> =>
	(await h.api("POST", "/api/cards", { projectId, title: "Add retry with backoff", brief: "5xx responses should be retried." })).body;

describe("acceptance gates", () => {
	it("a plan's test targets become red specs before building and green ones after", async () => {
		h = await bootHarness(script(), ENV);
		installAcceptanceRunner(h);
		const project = await addProject();
		await h.api("PATCH", `/api/projects/${project.id}`, { acceptanceGates: true });
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		// The planner was told to end the plan with test targets; the harness agent was pointed at the plan.
		const plan = h.driver.handles.find((handle) => handle.sessionId.includes("-plan-"));
		expect(plan?.prompts[0]).toContain("## Test targets");
		const harness = h.driver.handles.find((handle) => handle.sessionId.includes("acceptance-red"));
		expect(harness?.prompts[0]).toContain("plan.md");

		// Red held, so the plan gate opened; the builder inherits the specs as a contract.
		await approvePlanGate(card.id);
		const builder = h.driver.handles.find((handle) => handle.sessionId.includes("-build-"));
		expect(builder?.prompts[0]).toContain("Acceptance specs are the contract");
		expect(builder?.prompts[0]).toContain("without editing, deleting or weakening a spec");

		await h.daemon.whenIdle();
		const done = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(done.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		const red = done.runs.find((run: { id: string }) => run.id.includes("acceptance-red-red-gate"));
		expect(red).toMatchObject({ kind: "flow_step", resultStatus: "pass" });
		const green = done.runs.find((run: { id: string }) => run.id.includes("acceptance-green"));
		expect(green).toMatchObject({ kind: "flow_step", resultStatus: "pass" });
	});

	it("a spec that already passes fails the red gate: behavior before its build is a lie", async () => {
		h = await bootHarness(script({ specsWork: true }), ENV);
		installAcceptanceRunner(h);
		const project = await addProject();
		await h.api("PATCH", `/api/projects/${project.id}`, { acceptanceGates: true });
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		const stuck = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(stuck.card).toMatchObject({ stage: "planning", status: "needs_attention" });
		expect(stuck.card.needsAttentionReason).toContain("The after-plan flows did not pass");
		// The gate's feedback names the spec that already passes — the one that would have lied.
		expect(stuck.card.needsAttentionReason).toContain("PASS generated.mjs");
		expect(h.driver.handles.some((handle) => handle.sessionId.includes("-build-"))).toBe(false);
	});

	it("retrying a failed red gate reruns the harness with the failure as feedback, not the plan", async () => {
		// First attempt writes a spec that is not red; the retry — told what failed — writes a red one.
		h = await bootHarness((spec) => {
			if (spec.sessionId.includes("-plan-")) return [planningTurn()];
			if (spec.sessionId.includes("acceptance-red")) return [harnessTurn(!spec.sessionId.endsWith("-2"))];
			if (spec.sessionId.includes("-build-") || spec.sessionId.includes("-cifix-")) return [greenBuilderTurn()];
			if (spec.sessionId.includes("-test-")) return [testerTurn()];
			return [reviewTurn()];
		}, ENV);
		installAcceptanceRunner(h);
		const project = await addProject();
		await h.api("PATCH", `/api/projects/${project.id}`, { acceptanceGates: true });
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "planning", status: "needs_attention" });

		// The retry is feedback-only recovery: the flow reruns, the plan does not.
		await h.api("POST", `/api/cards/${card.id}/retry`);
		await h.daemon.whenIdle();

		const planRuns = h.driver.handles.filter((handle) => handle.sessionId.includes("-plan-"));
		expect(planRuns).toHaveLength(1);
		const rerun = h.driver.handles.find((handle) => handle.sessionId.endsWith("acceptance-red-write-specs-2"));
		expect(rerun?.prompts[0]).toContain("## What should change");
		expect(rerun?.prompts[0]).toContain("The after-plan flows did not pass");

		// Red held on the second attempt, so the plan gate opened without another planning session.
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		const redGate = detail.runs.find((run: { id: string }) => run.id.includes("acceptance-red-red-gate-2"));
		expect(redGate).toMatchObject({ kind: "flow_step", resultStatus: "pass" });
	});

	it("without the toggle, the acceptance flows never run", async () => {
		h = await bootHarness(script(), ENV);
		installAcceptanceRunner(h);
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		// The plan goes to its gate directly; no harness session, no gates.
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		expect(h.driver.handles.some((handle) => handle.sessionId.includes("acceptance"))).toBe(false);
		expect(detail.runs.some((run: { kind: string }) => run.kind === "flow_step")).toBe(false);
	});
});

async function approvePlanGate(cardId: string): Promise<void> {
	const detail = (await h.api("GET", `/api/cards/${cardId}`)).body;
	const gate = detail.gates.find((gate: { status: string }) => gate.status === "pending");
	if (gate) await h.api("POST", `/api/cards/${cardId}/gates/${gate.id}`, { decision: "approve", feedback: "" });
	await h.daemon.whenIdle();
}
