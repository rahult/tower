import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STAGE_RESULT_FILE } from "@tower/core";
import { bootHarness, buildingTurn, planningTurn, testerTurn, reviewTurn, type FakeScript, type FakeTurn, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

/** A scripted understanding step: writes the system model report where the prompt points, then a verdict. */
function understandTurn(verdict: "pass" | "fail" = "pass"): FakeTurn {
	return {
		events: [{ type: "message", message: { role: "assistant", text: "System model written.", thinking: "", toolCalls: [] } }],
		effect: ({ spec, prompt }) => {
			const report = prompt.match(/absolute path `([^`]+reviews\/[^`]+)`/)?.[1];
			if (report) {
				mkdirSync(dirname(report), { recursive: true });
				writeFileSync(report, "# System model\n\n## Domains\n\n- notes: storage of entries (`server/db.ts`).\n\n## Invariants as built\n\n- **INV-1** — a note's body is never empty (`server/app.ts:31`).\n");
			}
			writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: verdict, summary: verdict === "pass" ? "Model ready." : "Could not read the source." }));
		},
	};
}

/** Scripts the whole lifecycle, with the understanding pass passing or failing on demand. */
function script(firstUnderstanding: "pass" | "fail" = "pass"): FakeScript {
	let understandRuns = 0;
	return (spec) => {
		if (spec.sessionId.includes("understand-system")) return [understandTurn(++understandRuns === 1 ? firstUnderstanding : "pass")];
		if (spec.sessionId.includes("-plan-")) return [planningTurn()];
		if (spec.sessionId.includes("-build-") || spec.sessionId.includes("-cifix-")) return [buildingTurn()];
		if (spec.sessionId.includes("-test-")) return [testerTurn()];
		return [reviewTurn()];
	};
}

const addProject = async (): Promise<{ id: string }> => (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
const addCard = async (projectId: string): Promise<{ id: string }> =>
	(await h.api("POST", "/api/cards", { projectId, title: "Add retry with backoff", brief: "5xx responses should be retried." })).body;
const head = (): string => execFileSync("git", ["rev-parse", "main"], { cwd: h.repo, encoding: "utf8" }).trim();
const commitSomething = (): void => {
	writeFileSync(join(h.repo, `note-${Date.now()}.txt`), "moved on\n");
	execFileSync("git", ["add", "."], { cwd: h.repo });
	execFileSync("git", ["-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "move on"], { cwd: h.repo });
};

describe("the system model", () => {
	it("understanding a project promotes its report to a fresh model", async () => {
		h = await bootHarness(script(), ENV);
		const project = await addProject();
		const started = await h.api("POST", `/api/projects/${project.id}/understand`);
		expect(started.status).toBe(202);
		await h.daemon.whenIdle();

		const model = (await h.api("GET", `/api/projects/${project.id}/model`)).body;
		expect(model.state).toBe("fresh");
		expect(model.commit).toBe(head());
		const saved = readFileSync(join(h.home, "projects", project.id, "system-model.md"), "utf8");
		expect(saved).toContain("## Domains");
		expect(saved).toContain("INV-1");

		// The run lives on its own inert card: the audit trail for what the planner will read.
		const board = (await h.api("GET", "/api/board")).body;
		const carrier = board.cards.find((card: { title: string }) => card.title.startsWith("System model —"));
		expect(carrier).toBeDefined();
		expect(carrier).toMatchObject({ stage: "backlog" });
	});

	it("a model goes stale when the code moves past it, and the planner is told about both", async () => {
		h = await bootHarness(script(), ENV);
		const project = await addProject();
		await h.api("POST", `/api/projects/${project.id}/understand`);
		await h.daemon.whenIdle();

		commitSomething();
		expect(((await h.api("GET", `/api/projects/${project.id}/model`)).body).state).toBe("stale");

		// The next plan reads the model, at its absolute path, with its staleness on the record.
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const plan = h.driver.handles.find((handle) => handle.sessionId.includes("-plan-"));
		expect(plan?.prompts[0]).toContain("# System model");
		expect(plan?.prompts[0]).toContain(join(h.home, "projects", project.id, "system-model.md"));
		expect(plan?.prompts[0]).toContain("the codebase wins");
	});

	it("with the toggle on, a missing model is rebuilt before planning; off, it is not", async () => {
		h = await bootHarness(script(), { ...ENV, TOWER_UNDERSTAND_BEFORE_PLAN: "1" });
		const project = await addProject();
		await h.api("PATCH", `/api/projects/${project.id}`, { understandBeforePlan: true });

		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		// The before-plan hook ran first, then planning, then the plan gate.
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		const understand = h.driver.handles.findIndex((handle) => handle.sessionId.includes("understand-system"));
		const plan = h.driver.handles.findIndex((handle) => handle.sessionId.includes("-plan-"));
		expect(understand).toBeGreaterThanOrEqual(0);
		expect(understand).toBeLessThan(plan);
		expect(((await h.api("GET", `/api/projects/${project.id}/model`)).body).state).toBe("fresh");

		// A fresh model is not rebuilt: the next card plans straight away.
		const before = h.driver.handles.length;
		const second = await addCard(project.id);
		await h.api("POST", `/api/cards/${second.id}/enqueue`);
		await h.daemon.whenIdle();
		const fresh = h.driver.handles.slice(before).filter((handle) => handle.sessionId.includes("understand-system"));
		expect(fresh).toHaveLength(0);
	});

	it("with the toggle off, planning starts without an understanding pass", async () => {
		h = await bootHarness(script(), ENV);
		const project = await addProject();
		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		expect(h.driver.handles.some((handle) => handle.sessionId.includes("understand-system"))).toBe(false);
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card.status).toBe("awaiting_gate");
	});

	it("a failed understanding stops the card, and retry reruns the understanding — not the plan", async () => {
		h = await bootHarness(script("fail"), { ...ENV, TOWER_UNDERSTAND_BEFORE_PLAN: "1" });
		const project = await addProject();
		await h.api("PATCH", `/api/projects/${project.id}`, { understandBeforePlan: true });

		const card = await addCard(project.id);
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const stuck = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(stuck.card).toMatchObject({ stage: "planning", status: "needs_attention" });
		expect(stuck.card.needsAttentionReason).toContain("The before-plan understanding did not pass");
		expect(h.driver.handles.some((handle) => handle.sessionId.includes("-plan-"))).toBe(false);

		// Retry reruns the understanding (which passes on its second attempt), and only then plans.
		await h.api("POST", `/api/cards/${card.id}/retry`);
		await h.daemon.whenIdle();
		const understandSessions = h.driver.handles.filter((handle) => handle.sessionId.includes("understand-system"));
		expect(understandSessions).toHaveLength(2);
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
	});
});
