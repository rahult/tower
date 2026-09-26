import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { byStage, bootHarness, type FakeScript, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
	const harness = h;
	h = undefined as unknown as Harness;
	await harness?.close();
});

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

/** The two research sessions write to wherever their prompts point, like the real agents.
 *  `failFirstBrief` makes the synthesizer's first run falter, so the retry can prove itself. */
const researchScript = (failFirstBrief = false): FakeScript => {
	let briefRuns = 0;
	return (spec) => {
		if (spec.sessionId.includes("research-survey"))
			return [
				{
					events: [{ type: "message", message: { role: "assistant", text: "Survey written.", thinking: "", toolCalls: [] } }],
					effect: ({ prompt }) => {
						const report = prompt.match(/absolute path `([^`]+)`/)?.[1];
						if (report) writeFileSync(report, "# Survey notes\n\n- Finding one, sourced.\n- Finding two, sourced.");
					},
				},
			];
		if (spec.sessionId.includes("research-brief"))
			return [
				{
					events: [{ type: "message", message: { role: "assistant", text: "Brief written.", thinking: "", toolCalls: [] } }],
					effect: ({ prompt }) => {
						briefRuns += 1;
						const report = prompt.match(/absolute path `([^`]+)`/)?.[1];
						if (report && failFirstBrief && briefRuns === 1) return;
						if (report) writeFileSync(report, "# Research brief\n\n## Recommendation\n\n- Event-sourced sync behind the storage interface.");
					},
				},
			];
		return byStage()(spec);
	};
};

const addProject = async (): Promise<{ id: string }> => (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first survey hangs until cancelled; the retried run behaves like the standard script. */
const cancelScript = (): FakeScript => {
	let surveyRuns = 0;
	return (spec) => {
		if (spec.sessionId.includes("research-survey")) {
			surveyRuns += 1;
			if (surveyRuns === 1) return [{ events: [], hang: true }];
			return [
				{
					events: [{ type: "message", message: { role: "assistant", text: "Survey written.", thinking: "", toolCalls: [] } }],
					effect: ({ prompt }) => {
						const report = prompt.match(/absolute path `([^`]+)`/)?.[1];
						if (report) writeFileSync(report, "# Survey notes\n\n- Finding one, sourced.");
					},
				},
			];
		}
		if (spec.sessionId.includes("research-brief"))
			return [
				{
					events: [{ type: "message", message: { role: "assistant", text: "Brief written.", thinking: "", toolCalls: [] } }],
					effect: ({ prompt }) => {
						const report = prompt.match(/absolute path `([^`]+)`/)?.[1];
						if (report) writeFileSync(report, "# Research brief\n\n## Recommendation\n\n- Event-sourced sync.\n\nSource: <https://example.com/crdt>");
					},
				},
			];
		return byStage()(spec);
	};
};

describe("the research lane", () => {
	it("researches a question with no project, and the brief waits in the lane", async () => {
		h = await bootHarness(researchScript(), ENV);
		const asked = await h.api("POST", "/api/research", { question: "CRDT, event log, or last-write-wins for offline notes sync?" });
		expect(asked.status).toBe(202);
		const id = asked.body.question.id;
		expect(asked.body.question.status).toBe("running");

		await h.daemon.whenIdle();
		const brief = (await h.api("GET", "/api/research")).body.questions.find((question: { id: string }) => question.id === id);
		expect(brief).toMatchObject({ status: "brief" });
		expect(brief.brief).toContain("## Recommendation");

		// The scout saw the question, the synthesizer saw the scout's notes, and both runs count their spend.
		const survey = h.driver.handles.find((handle) => handle.sessionId.includes("research-survey"));
		const synthesizer = h.driver.handles.find((handle) => handle.sessionId.includes("research-brief"));
		expect(survey?.prompts[0]).toContain("CRDT, event log, or last-write-wins");
		expect(survey?.prompts[0]).toContain("Probe when reading is not enough");
		expect(synthesizer?.prompts[0]).toContain("survey.md");
		const db = new DatabaseSync(join(h.home, "tower.sqlite"));
		const oneoffs = db.prepare("SELECT kind, COUNT(*) AS n FROM oneoff_runs WHERE kind = 'research'").get() as { kind: string; n: number };
		db.close();
		expect(oneoffs.n).toBe(2);
	});

	it("a question whose research fails returns to open, and can be asked again", async () => {
		h = await bootHarness(researchScript(true), ENV);
		const asked = await h.api("POST", "/api/research", { question: "What is the state of local-first CRDT libraries?" });
		await h.daemon.whenIdle();
		expect((await h.api("GET", "/api/research")).body.questions[0].status).toBe("open");

		const rerun = await h.api("POST", `/api/research/${asked.body.question.id}/run`);
		expect(rerun.status).toBe(202);
		await h.daemon.whenIdle();
		expect((await h.api("GET", "/api/research")).body.questions[0].status).toBe("brief");

		// A running or already-brief question refuses a second run.
		expect((await h.api("POST", `/api/research/${asked.body.question.id}/run`)).status).toBe(409);
	});

	it("shows which step is in flight, and a cancel returns the question to open", async () => {
		h = await bootHarness(cancelScript(), ENV);
		const asked = await h.api("POST", "/api/research", { question: "CRDT or event log for offline notes sync?" });
		const id = asked.body.question.id;

		// While the survey runs, the lane can say what is happening — not just "running".
		let step: string | null = null;
		for (let i = 0; i < 100 && step === null; i++) {
			await sleep(20);
			step = (await h.api("GET", "/api/research")).body.questions[0].step;
		}
		expect(step).toBe("survey");

		expect((await h.api("POST", `/api/research/${id}/cancel`)).status).toBe(202);
		await h.daemon.whenIdle();
		expect((await h.api("GET", "/api/research")).body.questions[0]).toMatchObject({ status: "open", step: null });
		// A question that is not running refuses a cancel.
		expect((await h.api("POST", `/api/research/${id}/cancel`)).status).toBe(409);

		// And the question can still be asked again, all the way to its brief.
		await h.api("POST", `/api/research/${id}/run`);
		await h.daemon.whenIdle();
		const brief = (await h.api("GET", "/api/research")).body.questions[0];
		expect(brief).toMatchObject({ status: "brief", step: null });
		expect(brief.brief).toContain("example.com");
	});

	it("promotion files the brief as a card the planner will read", async () => {
		h = await bootHarness(researchScript(), ENV);
		const project = await addProject();
		const asked = await h.api("POST", "/api/research", { question: "CRDT or event log for offline notes sync?" });
		await h.daemon.whenIdle();
		const id = asked.body.question.id;

		// Promotion wants a project, and refuses to promote before the brief exists.
		expect((await h.api("POST", `/api/research/${id}/promote`, { projectId: "nope" })).status).toBe(404);

		const promoted = await h.api("POST", `/api/research/${id}/promote`, { projectId: project.id, title: "Local-first sync" });
		expect(promoted.status).toBe(201);
		const card = promoted.body.card;
		expect(card).toMatchObject({ title: "Local-first sync", stage: "backlog", status: "idle" });
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.artifacts.map((artifact: { name: string }) => artifact.name)).toEqual(expect.arrayContaining(["reviews/deep-research-synthesize.md", "reviews/deep-research-survey.md"]));
		expect((await h.api("GET", `/api/cards/${card.id}/artifacts/reviews%2Fdeep-research-synthesize.md`)).body).toContain("## Recommendation");
		const question = (await h.api("GET", "/api/research")).body.questions.find((entry: { id: string }) => entry.id === id);
		expect(question).toMatchObject({ status: "promoted", promotedCardId: card.id, promotedProjectId: project.id });

		// The point of the whole lane: the planner reads the brief without a copy-paste.
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const planner = h.driver.handles.find((handle) => handle.sessionId === `c${card.id}-plan-1`);
		expect(planner?.prompts[0]).toContain("deep-research-synthesize.md");
		expect(planner?.prompts[0]).toContain("A research brief for this task exists");
	});

	it("validates its input", async () => {
		h = await bootHarness(researchScript(), ENV);
		expect((await h.api("POST", "/api/research", { question: "" })).status).toBe(400);
		expect((await h.api("POST", "/api/research", { question: "x".repeat(2100) })).status).toBe(400);
		expect((await h.api("POST", "/api/research/nope/run")).status).toBe(404);
		expect((await h.api("POST", "/api/research/nope/promote", { projectId: "p" })).status).toBe(404);
	});
});
