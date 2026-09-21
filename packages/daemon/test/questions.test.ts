import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_RESULT_FILE } from "@tower/core";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness, planningTurn } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const QUESTIONS = [
	{ question: "What kind of app?", options: ["CLI", "Web app with a REST API"] },
	{ question: "Which SQLite driver?", options: ["better-sqlite3", "node:sqlite"] },
];

/** A planner that asks before it plans. The continued session (the second one the driver starts) then plans. */
const asksFirst = () => {
	let sessions = 0;
	return (spec: { sessionDir: string }) =>
		++sessions === 1
			? [{ events: [], effect: () => writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "blocked", summary: "Two decisions change the plan.", questions: QUESTIONS })) }]
			: [planningTurn()];
};

async function startCard(harness: Harness) {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: "Todo app", brief: "Typescript app using SQLite" })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	return card;
}

describe("a stage that asks questions", () => {
	it("waits for answers, showing the questions with their options", async () => {
		h = await bootHarness(asksFirst());
		const card = await startCard(h);
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_input", needsAttentionReason: "Two decisions change the plan." });
		expect(detail.runs[0]).toMatchObject({ resultStatus: "blocked", questions: QUESTIONS });
	});

	it("continues the same session with the answers, so nothing the agent learned is lost", async () => {
		h = await bootHarness(asksFirst());
		const card = await startCard(h);
		const answered = await h.api("POST", `/api/cards/${card.id}/answers`, {
			answers: [
				{ question: "What kind of app?", answer: "Web app with a REST API" },
				{ question: "Which SQLite driver?", answer: "Whatever needs no native build" },
			],
		});
		expect(answered.status).toBe(202);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ status: "awaiting_gate", needsAttentionReason: null });
		// One run, one pi session id: continued, not restarted.
		expect(detail.runs).toHaveLength(1);
		expect(detail.runs[0]).toMatchObject({ id: `c${card.id}-plan-1`, status: "settled", resultStatus: "pass", questions: null });
		const sessions = h.driver.handles.filter((handle) => handle.sessionId === `c${card.id}-plan-1`);
		expect(sessions).toHaveLength(2);
		const followUp = sessions[1]?.prompts[0] ?? "";
		expect(followUp).toContain("What kind of app?");
		expect(followUp).toContain("Web app with a REST API");
		expect(followUp).toContain("Whatever needs no native build");
		expect(followUp).toContain(STAGE_RESULT_FILE);
		expect(followUp).not.toContain("You are the **planner**");

		const items = (await h.api("GET", `/api/runs/c${card.id}-plan-1/transcript`)).body.items.map((item: { type: string }) => item.type);
		expect(items.filter((type: string) => type === "prompt")).toHaveLength(2);
	});

	it("rejects answers that are empty or not asked for", async () => {
		h = await bootHarness(asksFirst());
		const card = await startCard(h);
		expect((await h.api("POST", `/api/cards/${card.id}/answers`, { answers: [] })).status).toBe(400);
		expect((await h.api("POST", `/api/cards/${card.id}/answers`, { answers: [{ question: "What kind of app?", answer: " " }] })).status).toBe(400);

		const other = (await h.api("POST", "/api/cards", { projectId: card.projectId, title: "Idle card" })).body;
		expect((await h.api("POST", `/api/cards/${other.id}/answers`, { answers: [{ question: "q", answer: "a" }] })).status).toBe(409);
	});

	it("a blocked stage without questions still just asks for attention", async () => {
		h = await bootHarness((spec) => [{ events: [], effect: () => writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), '{"status":"blocked","summary":"No access to the staging database."}') }]);
		const card = await startCard(h);
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ status: "needs_attention", needsAttentionReason: "blocked: No access to the staging database." });
	});
});
