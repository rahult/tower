import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSpec } from "@tower/core";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, buildingTurn, byStage, simulationTurn, type Harness } from "./harness.ts";
import type { FakeTurn } from "../src/pi/fake-driver.ts";

let h: Harness;
afterEach(async () => h?.close());

/** A build that also leaves a simulation report behind, as the flow would before a re-test. */
const buildingWithSimulation = (): FakeTurn => ({
	events: buildingTurn().events,
	effect: ({ spec }) => {
		buildingTurn().effect?.({ spec, prompt: "" });
		const cardDir = join(spec.sessionDir, "..");
		mkdirSync(join(cardDir, "reviews"), { recursive: true });
		writeFileSync(join(cardDir, "reviews", "invariant-simulation.md"), "# Invariant simulation\n\n## Test targets\n\n- **INV-1** — a retried request never duplicates a side effect.\n");
	},
});

const seedCard = async (title: string) => {
	const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
	const card = (await h.api("POST", "/api/cards", { projectId: project.id, title, brief: "Wrap request() with retries." })).body;
	return { project, card };
};

const promptFor = (cardId: string, slug: string) => h.driver.handles.find((handle) => handle.sessionId === `c${cardId}-${slug}-1`)?.prompts[0] ?? "";

const driveToTesting = async (cardId: string) => {
	await h.api("POST", `/api/cards/${cardId}/enqueue`);
	await h.daemon.whenIdle();
	const gate = (await h.api("GET", `/api/cards/${cardId}`)).body.gates[0];
	await h.api("POST", `/api/cards/${cardId}/gates/${gate.id}`, { decision: "approve" });
	await h.daemon.whenIdle();
};

describe("invariant simulation", () => {
	it("is on by default: planning models, building honors, testing derives its own checklist", async () => {
		h = await bootHarness(byStage());
		expect((await h.api("GET", "/api/settings")).body.invariantSimulation).toBe(true);
		const { project, card } = await seedCard("Add retries to the client");
		await driveToTesting(card.id);

		const plan = promptFor(card.id, "plan");
		expect(plan).toContain("# Model and invariants");
		expect(plan).toContain("## Model and invariants");
		expect(plan).toContain("Test targets");
		expect(plan).not.toMatch(/\{\{/);

		const build = promptFor(card.id, "build");
		expect(build).toContain("# Model and invariants");
		expect(build).toContain("acceptance criteria");

		const test = promptFor(card.id, "test");
		expect(test).toContain("# Invariant checklist");
		expect(test).toContain("derive the checklist yourself");
		expect(test).toContain("The method");
		expect(test).not.toMatch(/\{\{/);
	});

	it("switches testing to verifying the report once a simulation has run", async () => {
		h = await bootHarness(byStage({ build: buildingWithSimulation }));
		const { card } = await seedCard("Add retries to the client");
		await driveToTesting(card.id);

		const test = promptFor(card.id, "test");
		expect(test).toContain("A simulation has modeled this change");
		expect(test).toContain("Test targets");
		expect(test).not.toContain("derive the checklist yourself");
	});

	it("can be turned off globally and re-enabled per project", async () => {
		h = await bootHarness(byStage(), { TOWER_INVARIANT_SIMULATION: "0" });
		expect((await h.api("GET", "/api/settings")).body.invariantSimulation).toBe(false);
		const { project, card } = await seedCard("Add retries to the client");
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		expect(promptFor(card.id, "plan")).not.toContain("# Model and invariants");

		expect((await h.api("PATCH", `/api/projects/${project.id}`, { invariantSimulation: true })).body.invariantSimulation).toBe(true);
		const second = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add jitter" })).body;
		await h.api("POST", `/api/cards/${second.id}/enqueue`);
		await h.daemon.whenIdle();
		expect(promptFor(second.id, "plan")).toContain("# Model and invariants");

		expect((await h.api("PATCH", `/api/projects/${project.id}`, { invariantSimulation: "yes" })).status).toBe(400);
	});

	it("can be turned off for one project while the default stays on, and survives a restart", async () => {
		h = await bootHarness(byStage());
		const { project, card } = await seedCard("Add retries to the client");
		expect((await h.api("PATCH", `/api/projects/${project.id}`, { invariantSimulation: false })).body.invariantSimulation).toBe(false);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		expect(promptFor(card.id, "plan")).not.toContain("# Model and invariants");

		await h.restart();
		const board = (await h.api("GET", "/api/board")).body;
		expect(board.projects.find((p: { id: string }) => p.id === project.id).invariantSimulation).toBe(false);
		const second = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add jitter" })).body;
		await h.api("POST", `/api/cards/${second.id}/enqueue`);
		await h.daemon.whenIdle();
		expect(promptFor(second.id, "plan")).not.toContain("# Model and invariants");
	});

	it("runs as a flow with the planning-tier model, read-and-run tools and a model report", async () => {
		const script = (spec: RunSpec) => {
			if (spec.sessionId.includes("invariant-simulation")) return [simulationTurn("fail")];
			return byStage()(spec);
		};
		h = await bootHarness(script, { TOWER_REVIEW_FLOWS: "invariant-simulation" });
		const { card } = await seedCard("Add retries to the client");
		await driveToTesting(card.id);

		// Testing passes with no verify command, then the flow runs on the way to the feedback gate.
		const flow = h.driver.handles.find((handle) => handle.sessionId.includes("invariant-simulation"));
		expect(flow).toBeDefined();
		expect(flow?.spec.model).toBe("anthropic/claude-fable-5-1");
		expect(flow?.spec.thinking).toBe("high");
		expect(flow?.spec.tools).toContain("bash");
		expect(flow?.spec.tools).not.toContain("edit");
		expect(flow?.prompts[0]).toContain("invariant simulator");
		expect(flow?.prompts[0]).toContain("The method");
		expect(flow?.prompts[0]).toContain("git diff");
		expect(flow?.prompts[0]).not.toMatch(/\{\{/);

		expect(existsSync(join(h.home, "cards", card.id, "reviews", "invariant-simulation.md"))).toBe(true);
		const run = (await h.api("GET", `/api/cards/${card.id}`)).body.runs.find((r: { id: string }) => r.id.includes("invariant-simulation"));
		expect(run).toMatchObject({ kind: "flow_step", status: "settled", resultStatus: "fail", resultSummary: "1 blocking finding." });

		// The loop rests where a person decides, with the findings waiting at the feedback gate.
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		expect(detail.gates.find((gate: { status: string }) => gate.status === "pending")).toMatchObject({ kind: "feedback", status: "pending" });
	});
});
