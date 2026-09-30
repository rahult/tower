import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_RESULT_FILE } from "@tower/core";
import { afterEach, describe, expect, it } from "vitest";
import { nextStep, parseFlow } from "../src/flows.ts";
import { bootHarness, byStage, planningTurn, type FakeScript, type FakeTurn, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
	const harness = h;
	h = undefined as unknown as Harness;
	await harness?.close();
});

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

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

describe("flow graphs parse", () => {
	it("holds edges to real verdicts and real steps", () => {
		const base = '{"name":"x","steps":[{"name":"a","run":"true"}';
		expect(() => parseFlow(`${base},"on":{"skip":"a"}]}{"name":"b","run":"true"}]}`, "t")).toThrow();
		expect(() => parseFlow('{"name":"x","steps":[{"name":"a","run":"true","on":{"skip":"a"}}]}', "t")).toThrow('only "pass" and "fail"');
		expect(() => parseFlow('{"name":"x","steps":[{"name":"a","run":"true","on":{"pass":"nowhere"}}]}', "t")).toThrow("not a step of this flow");
		expect(() => parseFlow('{"name":"x","steps":[{"name":"a","run":"true","on":{}}]}', "t")).toThrow('empty "on"');
		expect(() => parseFlow('{"name":"x","steps":[{"name":"a","run":"true","maxRuns":0}]}', "t")).toThrow("maxRuns");
		expect(() => parseFlow('{"name":"x","start":"late","steps":[{"name":"a","run":"true"}]}', "t")).toThrow('"start"');
		// A text step is its own kind: alone it is valid, beside another kind it is not.
		expect(() => parseFlow('{"name":"x","steps":[{"name":"a","text":"Look around.","prompt":"b.md"}]}', "t")).toThrow("exactly one of");
		const good = parseFlow(
			'{"name":"x","start":"a","layout":{"a":{"x":1,"y":2}},"steps":[{"name":"a","text":"Look around.","on":{"fail":"a"},"maxRuns":2},{"name":"b","run":"true"}]}',
			"t",
		);
		expect(good).toMatchObject({
			start: "a",
			layout: { a: { x: 1, y: 2 } },
			steps: [{ on: { fail: "a" }, maxRuns: 2 }, { run: "true" }],
		});
	});

	it("nextStep: the edge wins, then file order, then the flow ends", () => {
		const flow = parseFlow('{"name":"x","steps":[{"name":"a","run":"true","on":{"fail":"a"}},{"name":"b","run":"true"}]}', "t");
		expect(nextStep(flow, flow.steps[0]!, "fail")?.name).toBe("a"); // the self-loop
		expect(nextStep(flow, flow.steps[0]!, "pass")?.name).toBe("b"); // fallthrough
		expect(nextStep(flow, flow.steps[1]!, "pass")).toBeNull(); // the end
	});
});

describe("flow graphs run", () => {
	it("a failed gate routes to a repair step and returns through the gate", async () => {
		h = await bootHarness((spec) => {
			if (spec.sessionId.includes("harden-fix"))
				return [
					{
						events: [{ type: "message", message: { role: "assistant", text: "Fixed.", thinking: "", toolCalls: [] } }],
						effect: ({ spec: handle, prompt }) => {
							// The inline instructions reached the session, with the result contract appended.
							expect(prompt).toContain("Create fixed.txt");
							expect(prompt).toContain("Reporting your result");
							writeFileSync(join(handle.cwd, "fixed.txt"), "repaired\n");
							writeFileSync(join(handle.sessionDir, "..", handle.resultPath ?? STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Repaired." }));
						},
					},
				];
			return byStage()(spec);
		}, ENV);
		homeFlow(h, "harden", {
			name: "harden",
			title: "Harden",
			description: "A gate that routes its failure to a repair step.",
			when: ["manual"],
			start: "gate",
			steps: [
				{ name: "gate", run: "test -f {{worktreePath}}/fixed.txt || { echo 'fixed.txt is missing'; exit 3; }", on: { pass: "done", fail: "fix" } },
				{ name: "fix", text: "The gate failed. Create fixed.txt in {{worktreePath}} so it passes, then report.", access: "write", maxRuns: 2, on: { pass: "gate" } },
				{ name: "done", run: "echo done", expect: "note" },
			],
		});
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		const res = await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "harden" });
		expect(res.status).toBe(202);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		const steps = detail.runs.filter((run: { kind: string }) => run.kind === "flow_step");
		expect(steps.map((run: { id: string }) => run.id.replace(`c${card.id}-harden-`, ""))).toEqual(["gate-1", "fix-1", "gate-2", "done-1"]);
		expect(steps.find((run: { id: string }) => run.id.endsWith("gate-1"))).toMatchObject({ resultStatus: "fail" });
		expect(steps.find((run: { id: string }) => run.id.endsWith("gate-2"))).toMatchObject({ resultStatus: "pass" });
		expect(steps.find((run: { id: string }) => run.id.endsWith("done-1"))).toMatchObject({ resultStatus: "pass" });
	});

	it("a repair loop that cannot converge is stopped by the node's cap, not spun forever", async () => {
		h = await bootHarness(byStage(), ENV);
		homeFlow(h, "stuck", {
			name: "stuck",
			title: "Stuck",
			description: "The gate never passes.",
			when: ["manual"],
			start: "gate",
			steps: [
				{ name: "gate", run: "exit 3", on: { fail: "fix" } },
				{ name: "fix", text: "Try to fix it.", maxRuns: 2, on: { pass: "gate" } },
			],
		});
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		const res = await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "stuck" });
		expect(res.status).toBe(202);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		const ids = detail.runs.filter((run: { kind: string }) => run.kind === "flow_step").map((run: { id: string }) => run.id.replace(`c${card.id}-stuck-`, ""));
		// Three gates, two fixes, and the third fix never starts: the cap ends the loop.
		expect(ids).toEqual(["gate-1", "fix-1", "gate-2", "fix-2", "gate-3"]);
	});

	it("a linear flow without edges still runs in file order and stops at a failed gate", async () => {
		h = await bootHarness(byStage(), ENV);
		homeFlow(h, "plain", {
			name: "plain",
			title: "Plain",
			description: "",
			when: ["manual"],
			steps: [
				{ name: "fail-here", run: "exit 1" },
				{ name: "never", run: "echo never" },
			],
		});
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		await h.api("POST", `/api/cards/${card.id}/adhoc`, { flow: "plain" });
		await h.daemon.whenIdle();
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		const ids = detail.runs.filter((run: { kind: string }) => run.kind === "flow_step").map((run: { id: string }) => run.id.replace(`c${card.id}-plain-`, ""));
		expect(ids).toEqual(["fail-here-1"]);
	});
});

describe("compose a flow for a task", () => {
	const VALID = {
		name: "smoke-check",
		title: "Smoke check",
		description: "An agent looks, a gate proves.",
		when: ["manual"],
		steps: [
			{ name: "look", text: "Read {{brief}} and check the retry logic exists in {{worktreePath}}." },
			{ name: "prove", run: "true" },
		],
	};

	it("drafts a flow, retries once on invalid JSON, and saves only when the person confirms", async () => {
		h = await bootHarness((spec) => {
			if (spec.sessionId.startsWith("flow-compose"))
				return [
					{ events: [{ type: "message", message: { role: "assistant", text: '{"name":"smoke-check","steps":[]}', thinking: "", toolCalls: [] } }] },
					{ events: [{ type: "message", message: { role: "assistant", text: JSON.stringify(VALID), thinking: "", toolCalls: [] } }] },
				];
			const stages = byStage()(spec);
			return spec.sessionId.includes("-plan-") ? [planningTurn()] : stages;
		}, ENV);
		const project = await addProject();
		const card = await addCard(project.id);

		const res = await h.api("POST", `/api/cards/${card.id}/compose-flow`, {});
		expect(res.status).toBe(200);
		expect(res.body.draft).toMatchObject({ name: "smoke-check" });
		const session = h.driver.handles.find((handle) => handle.sessionId.startsWith("flow-compose"));
		expect(session?.prompts[0]).toContain("Add retry with backoff");
		expect(session?.prompts[0]).toContain("5xx responses should be retried");
		// The rejection went back to the same session before the person saw a failure.
		expect(session?.prompts[1]).toContain("was rejected");
		expect(session?.prompts[1]).toContain("at least one step");

		// Nothing saved itself: the flow does not exist until the person confirms.
		expect(existsSync(join(h.home, "flows", "smoke-check.flow.json"))).toBe(false);
		const saved = await h.api("POST", "/api/flows", { flow: res.body.draft });
		expect(saved.status).toBe(201);
		expect(saved.body.overridden).toBe(false);
		expect(readFileSync(join(h.home, "flows", "smoke-check.flow.json"), "utf8")).toContain("smoke-check");
		const listed = (await h.api("GET", "/api/flows")).body;
		expect(listed.flows.find((flow: { name: string }) => flow.name === "smoke-check")).toMatchObject({ source: "custom" });
		expect(listed.flows.find((flow: { name: string }) => flow.name === "deep-research")).toMatchObject({ source: "shipped" });
	});

	it("rejects a draft that never validates, and validates what the person saves", async () => {
		h = await bootHarness((spec) => {
			if (spec.sessionId.startsWith("flow-compose"))
				return [
					{ events: [{ type: "message", message: { role: "assistant", text: "no json at all", thinking: "", toolCalls: [] } }] },
					{ events: [{ type: "message", message: { role: "assistant", text: '{"name":"bad","steps":[{"name":"a","run":"true","on":{"pass":"ghost"}}]}', thinking: "", toolCalls: [] } }] },
				];
			return byStage()(spec);
		}, ENV);
		const project = await addProject();
		const card = await addCard(project.id);
		const res = await h.api("POST", `/api/cards/${card.id}/compose-flow`, {});
		expect(res.status).toBe(400);
		expect(res.body.error).toContain("not a step of this flow");

		expect((await h.api("POST", "/api/flows", { flow: { name: "Bad Name", steps: [] } })).status).toBe(400);
		expect((await h.api("DELETE", "/api/flows/smoke-check")).status).toBe(404);
	});

	it("saving can override a shipped flow, and deleting removes only the person's copy", async () => {
		h = await bootHarness(byStage(), ENV);
		const overridden = await h.api("POST", "/api/flows", { flow: { name: "deep-research", title: "My research", when: ["manual"], steps: [{ name: "go", run: "true" }] } });
		expect(overridden.status).toBe(201);
		expect(overridden.body.overridden).toBe(true);
		expect((await h.api("GET", "/api/flows")).body.flows.find((flow: { name: string }) => flow.name === "deep-research")).toMatchObject({ title: "My research", source: "custom" });
		expect((await h.api("DELETE", "/api/flows/deep-research")).status).toBe(200);
		// The override is gone; the shipped original is what loads again.
		expect((await h.api("GET", "/api/flows")).body.flows.find((flow: { name: string }) => flow.name === "deep-research")).toMatchObject({ title: "Deep research", source: "shipped" });
	});
});
