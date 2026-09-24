import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveStageConfig, type RunSpec } from "@tower/core";
import { type Config } from "./config.ts";
import type { SessionDriver } from "./pi/session-driver.ts";

/** One proposed backlog card, cut from a plan. */
export interface PlanCard {
	title: string;
	brief: string;
}

export const PLAN_CARDS_MAX = 12;
const PLAN_CHARS_MAX = 40_000;
const TIMEOUT_MS = 120_000;

export function splitPrompt(projectName: string, plan: string): string {
	return [
		`You are the work-breakdown planner for Tower, a board where agents plan, build and test one card at a time. The person hands you a plan for the project "${projectName}"; cut it into backlog cards, each of which Tower can plan, build and verify on its own.`,
		"",
		"The plan:",
		"",
		plan,
		"",
		"How to cut:",
		"- Between 3 and 12 cards. Each card is one coherent, independently buildable and independently verifiable piece of work; order them so foundations come first and later cards can assume earlier ones are merged.",
		"- Each card's brief must stand completely alone: the planner that reads it sees nothing else. Say what to build, for whom, the constraints that matter, and how to verify. Copy the plan's relevant detail into the brief rather than referring to \"the plan\" or \"step 2\".",
		"- Never split mid-feature; fold tiny steps into the card that needs them; one card may carry the shared groundwork if several others depend on it.",
		"- The plan is the source of truth: do not invent scope it does not have, and do not add meta-work (docs, cleanup) unless the plan asks.",
		"",
		"Reply with ONE JSON object and nothing else — no prose, no code fence:",
		'{"cards":[{"title":"<short imperative title, at most 80 characters>","brief":"<the self-contained brief>"}]}',
	].join("\n");
}

/**
 * One tool-less session: a plan goes in, proposed backlog cards come out. Nothing is filed —
 * the person sees the draft first and files what they want.
 */
export async function splitPlan(options: { config: Config; driver: SessionDriver; projectName: string; plan: string }): Promise<PlanCard[]> {
	const { config, driver, projectName, plan } = options;
	const trimmed = plan.trim();
	if (trimmed.length < 40) throw new Error("That plan is too short to cut — paste the plan text or pick a card with a plan");
	if (trimmed.length > PLAN_CHARS_MAX) throw new Error(`That plan is too long (${trimmed.length} characters; the ceiling is ${PLAN_CHARS_MAX}) — cut it in two first`);

	// Breakdown is planning-shaped work: it wants the strong tier, not the cheap one.
	const model = resolveStageConfig("planning", { global: config.globalStageConfig });
	const sessionId = `plan-split-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
	const sessionDir = join(config.home, "plan-split", sessionId, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const spec: RunSpec = { sessionId, cwd: config.home, sessionDir, model: model.model, thinking: model.thinking, tools: [], extensions: [], trustProject: false, appendSystemPromptFiles: [] };
	const handle = await driver.start(spec);
	let reply = "";
	const off = handle.onEvent((event: { type: string; message?: { role: string; text?: string } }) => {
		if (event.type === "message" && event.message?.role === "assistant" && event.message.text?.trim()) reply = event.message.text;
	});
	try {
		await handle.prompt(splitPrompt(projectName, trimmed));
		let timedOut = false;
		await Promise.race([
			handle.waitSettled(),
			new Promise<never>((_, reject) => {
				const timer = setTimeout(() => {
					timedOut = true;
					reject(new Error("the work-breakdown session timed out"));
				}, TIMEOUT_MS);
				timer.unref();
			}),
		]).catch((error) => {
			throw timedOut ? error : new Error(`the work-breakdown session died: ${error instanceof Error ? error.message : String(error)}`);
		});
	} finally {
		await handle.stop().catch(() => {});
		off();
	}
	return parsePlanCards(reply);
}

/** Pulls the proposed cards out of the model's reply, tolerating a stray sentence or code fence. */
export function parsePlanCards(reply: string): PlanCard[] {
	const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		throw new Error("the work-breakdown session did not return usable cards — try again");
	}
	const list = (raw as { cards?: unknown }).cards;
	if (!Array.isArray(list) || list.length === 0) throw new Error("the work-breakdown session proposed no cards — try again");
	return list.slice(0, PLAN_CARDS_MAX).flatMap((entry) => {
		const card = entry as Partial<PlanCard>;
		const title = typeof card.title === "string" ? card.title.trim().slice(0, 120) : "";
		const brief = typeof card.brief === "string" ? card.brief.trim().slice(0, 4000) : "";
		return title && brief ? [{ title, brief }] : [];
	});
}
