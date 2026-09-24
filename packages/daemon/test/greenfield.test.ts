import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { byStage, bootHarness, planningTurn, type FakeScript, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const ENV = {
	TOWER_REVIEW_FLOWS: "",
	TOWER_PR_POLL_MS: "0",
	TOWER_ARCHETYPES_DIR: join(import.meta.dirname, "fixtures", "archetypes"),
};

describe("a project born from an idea", () => {
	it("scaffolds the archetype, registers the project, and starts planning the idea", async () => {
		h = await bootHarness(byStage(), ENV);

		const listed = (await h.api("GET", "/api/archetypes")).body;
		expect(listed.archetypes.map((archetype: { name: string }) => archetype.name)).toContain("mini");

		const created = await h.api("POST", "/api/projects/from-idea", { name: "todo app", idea: "Keep a list of todos with due dates.", archetype: "mini" });
		expect(created.status).toBe(201);
		const { project, card } = created.body;
		// The project is born knowing its commands (from the manifest); the fixture archetype declares no
		// acceptance contract, so its gates follow Tower's default.
		expect(project).toMatchObject({
			name: "todo app",
			verifyCommand: "cat README.md",
			acceptanceGates: null,
			understandBeforePlan: false,
			hasOrigin: false,
			defaultBranch: "main",
		});
		expect(project.repoPath).toContain(join("repos", "todo-app"));

		// The repository exists, scaffolded and committed as the baseline.
		expect(readFileSync(join(project.repoPath, "src", "index.js"), "utf8")).toContain("mini");
		const log = execFileSync("git", ["log", "--format=%s"], { cwd: project.repoPath, encoding: "utf8" });
		expect(log).toContain("Scaffold from the mini archetype");

		// The idea is the first card, already planning — no human step between the idea and the plan.
		expect(card.brief).toBe("Keep a list of todos with due dates.");
		await h.daemon.whenIdle();
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		const plan = h.driver.handles.find((handle) => handle.sessionId.includes("-plan-"));
		expect(plan?.prompts[0]).toContain("Keep a list of todos with due dates.");
	});

	it("refuses an archetype that does not exist", async () => {
		h = await bootHarness(byStage(), ENV);
		const created = await h.api("POST", "/api/projects/from-idea", { name: "x", idea: "y", archetype: "nope" });
		expect(created.status).toBe(400);
		expect(created.body.error).toContain("no archetype");
	});

	it("a second idea with the same name lands in its own directory", async () => {
		h = await bootHarness(byStage(), ENV);
		const first = (await h.api("POST", "/api/projects/from-idea", { name: "todo app", idea: "one", archetype: "mini" })).body;
		const second = (await h.api("POST", "/api/projects/from-idea", { name: "todo app", idea: "two", archetype: "mini" })).body;
		expect(second.project.repoPath).toBe(`${first.project.repoPath}-2`);
		expect(existsSync(join(first.project.repoPath, "src"))).toBe(true);
		expect(existsSync(join(second.project.repoPath, "src"))).toBe(true);
	});

	it("the ask box reads a build-from-scratch line as a new project, even on an empty board", async () => {
		const script: FakeScript = (spec) => {
			if (spec.sessionId.includes("assist"))
				return [{ events: [{ type: "message", message: { role: "assistant", text: JSON.stringify({ action: "new_project", project: "", title: "Create a todo app", brief: "Todos with due dates, shared by two people." }), thinking: "", toolCalls: [] } }] }];
			if (spec.sessionId.includes("-plan-")) return [planningTurn()];
			return [];
		};
		h = await bootHarness(script, ENV);
		// No projects on the board yet — the whole point of this action.
		const outcome = (await h.api("POST", "/api/assist", { text: "create a todo app" })).body;
		expect(outcome).toMatchObject({ ok: true, action: "new_project", projectId: outcome.projectId });
		expect(outcome.reply).toContain("Scaffolding");

		const board = (await h.api("GET", "/api/board")).body;
		expect(board.projects).toHaveLength(1);
		expect(board.projects[0].repoPath).toContain(join("repos", "create-a-todo-app"));
		await h.daemon.whenIdle();
		const detail = (await h.api("GET", `/api/cards/${outcome.card.id}`)).body;
		expect(detail.card.stage).toBe("planning");
	});
});
