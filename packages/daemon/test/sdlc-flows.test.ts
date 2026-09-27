import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STAGE_RESULT_FILE, type RunSpec } from "@tower/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { loadFlows, runsOnBacklogCard } from "../src/flows.ts";
import { bootHarness, byStage, type FakeScript, type FakeTurn, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
	const harness = h;
	h = undefined as unknown as Harness;
	await harness?.close();
});

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

const SUITE = ["idea-to-brief", "threat-model", "sec-sweep", "stability-check", "production-ready", "dependency-watch"];

describe("the sdlc flow suite", () => {
	it("ships parseable, backlog-safe, opt-in flows", () => {
		const flows = loadFlows(loadConfig({}));
		for (const name of SUITE) {
			const flow = flows.find((candidate) => candidate.name === name);
			expect(flow, `${name} is missing`).toBeTruthy();
			// A scheduled watch and a manual sweep both have to run on a card with no worktree.
			expect(runsOnBacklogCard(flow!), `${name} must be backlog-safe`).toBe(true);
			// Every flow pays for itself with a real description in the Run tab.
			expect(flow!.title).not.toBe(flow!.name);
			expect(flow!.description.length).toBeGreaterThan(60);
		}
		// The default pipeline is unchanged: the suite is opt-in per concern, except the weekly watch.
		for (const name of SUITE) {
			const flow = flows.find((candidate) => candidate.name === name)!;
			expect(flow.when.filter((trigger) => trigger !== "manual" && trigger !== "schedule")).toEqual([]);
		}
	});

	it("turns a raw idea on a backlog card into a buildable brief", async () => {
		h = await bootHarness(scriptedFlows(), ENV);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Local-first sync for notes", brief: "Notes should sync between devices without a server." })).body;

		const res = await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "idea-to-brief" });
		expect(res.status).toBe(202);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		// The card never left the backlog: research runs read-only in the checkout.
		expect(detail.card).toMatchObject({ stage: "backlog", status: "idle" });
		const labels = detail.runs.filter((run: { kind: string }) => run.kind === "flow_step").map((run: { id: string }) => run.id.replace(`c${card.id}-idea-to-brief-`, "").replace(/-\d+$/, ""));
		expect(labels).toEqual(["explore", "brief"]);
		const reviews = detail.artifacts.filter((artifact: { name: string }) => artifact.name.startsWith("reviews/")).map((artifact: { name: string }) => artifact.name);
		expect(reviews).toEqual(["reviews/idea-to-brief-brief.md", "reviews/idea-to-brief-explore.md"]);
		const explore = h.driver.handles.find((handle) => handle.sessionId.includes("idea-to-brief-explore"));
		expect(explore?.prompts[0]).toContain("Notes should sync between devices");
		expect(explore?.prompts[0]).toContain("idea-to-brief-explore.md");
		// Every hole was filled: no template braces reach a model.
		expect(explore?.prompts[0]).not.toMatch(/\{\{/);
		expect(explore?.spec.cwd).toBe(h.repo);
	});

	it("sec-sweep fails the run on confirmed findings and leaves the card where it is", async () => {
		h = await bootHarness(scriptedFlows(), ENV);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add retry with backoff", brief: "5xx responses should be retried." })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const resting = (await h.api("GET", `/api/cards/${card.id}`)).body.card;

		const res = await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "sec-sweep" });
		expect(res.status).toBe(202);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		const sweep = detail.runs.find((run: { id: string }) => run.id.startsWith(`c${card.id}-sec-sweep-`));
		expect(sweep).toMatchObject({ kind: "flow_step", resultStatus: "fail", resultSummary: "1 confirmed" });
		// An ad hoc sweep is a finding, not a lifecycle event: the card rests where it was.
		expect(detail.card).toMatchObject({ stage: resting.stage, status: resting.status });
		const handle = h.driver.handles.find((handle) => handle.sessionId.includes("sec-sweep"));
		// The disprove pass is in the prompt, and the worktree is where it sweeps.
		expect(handle?.prompts[0]).toContain("Disprove");
		expect(handle?.spec.cwd).toBe(resting.worktreePath);
	});
});

describe("per-project hook gates", () => {
	async function addCard(projectId: string, title = "Add retry with backoff"): Promise<{ id: string }> {
		return (await h.api("POST", "/api/cards", { projectId, title, brief: "5xx responses should be retried." })).body;
	}

	async function approvePlanGate(cardId: string): Promise<void> {
		const detail = (await h.api("GET", `/api/cards/${cardId}`)).body;
		const gate = detail.gates.find((gate: { status: string }) => gate.status === "pending");
		if (gate) await h.api("POST", `/api/cards/${cardId}/gates/${gate.id}`, { decision: "approve", feedback: "" });
		await h.daemon.whenIdle();
	}

	it("a project runs exactly the flows it names at each gate, and validation refuses ghosts", async () => {
		h = await bootHarness(scriptedFlows(), ENV);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const patched = await h.api("PATCH", `/api/projects/${project.id}`, { afterPlanFlows: ["threat-model"], afterBuildFlows: ["stability-check"] });
		expect(patched.status).toBe(200);
		expect(patched.body).toMatchObject({ afterPlanFlows: ["threat-model"], afterBuildFlows: ["stability-check"] });
		expect((await h.api("PATCH", `/api/projects/${project.id}`, { afterPlanFlows: ["ghost"] })).status).toBe(400);

		// After the plan: the named gate runs between the plan and its approval.
		const planned = await addCard(project.id);
		await h.api("POST", `/api/cards/${planned.id}/enqueue`);
		await h.daemon.whenIdle();
		let detail = (await h.api("GET", `/api/cards/${planned.id}`)).body;
		expect(detail.runs.find((run: { id: string }) => run.id.startsWith(`c${planned.id}-threat-model-`))).toBeTruthy();
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });

		// After the build: the named gate runs, passes, and the card moves on to testing.
		const built = await addCard(project.id, "Add request timeouts");
		await h.api("POST", `/api/cards/${built.id}/enqueue`);
		await h.daemon.whenIdle();
		await approvePlanGate(built.id);
		detail = (await h.api("GET", `/api/cards/${built.id}`)).body;
		expect(detail.runs.find((run: { id: string }) => run.id.startsWith(`c${built.id}-stability-check-`))).toMatchObject({ resultStatus: "pass" });
		expect(detail.card.stage).not.toBe("building");

		// An empty list is the off switch: no gate runs at all.
		await h.api("PATCH", `/api/projects/${project.id}`, { afterPlanFlows: [] });
		const quiet = await addCard(project.id, "Rename a label");
		await h.api("POST", `/api/cards/${quiet.id}/enqueue`);
		await h.daemon.whenIdle();
		detail = (await h.api("GET", `/api/cards/${quiet.id}`)).body;
		expect(detail.runs.some((run: { id: string }) => run.id.includes("threat-model"))).toBe(false);
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
	});
});

/** One scripted session per flow step that matters here: reports land, verdicts come home. */
function scriptedFlows(): FakeScript {
	const turn = (label: string, verdict: "pass" | "fail" = "pass"): FakeTurn[] => [
		{
			events: [{ type: "message", message: { role: "assistant", text: `${label} done.`, thinking: "", toolCalls: [] } }],
			effect: ({ spec, prompt }: { spec: RunSpec; prompt: string }) => {
				const report = prompt.match(/absolute path `([^`]+reviews\/[^`]+)`/)?.[1];
				if (report) {
					mkdirSync(dirname(report), { recursive: true });
					writeFileSync(report, `# ${label}\n\n- A finding with a source https://example.com\n`);
				}
				writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: verdict, summary: verdict === "fail" ? "1 confirmed" : `${label} ready.` }));
			},
		},
	];
	return (spec) => {
		if (spec.sessionId.includes("idea-to-brief-explore")) return turn("Explore");
		if (spec.sessionId.includes("idea-to-brief-brief")) return turn("Brief");
		if (spec.sessionId.includes("sec-sweep")) return turn("Sweep", "fail");
		if (spec.sessionId.includes("threat-model")) return turn("Threat model");
		if (spec.sessionId.includes("stability-check")) return turn("Stability");
		if (spec.sessionId.includes("production-ready")) return turn("Audit");
		if (spec.sessionId.includes("dependency-watch")) return turn("Watch");
		return byStage()(spec);
	};
}
