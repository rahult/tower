import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveStageConfig, type RunSpec } from "@tower/core";
import type { Config } from "./config.ts";
import type { SessionDriver } from "./pi/session-driver.ts";

export type AssistAction = "add_card" | "start_card" | "none";

export interface AssistVerdict {
	action: AssistAction;
	project: string;
	title: string;
	brief: string;
}

/** How long a one-line ask may take to interpret before the caller files it as-is. */
const ASSIST_TIMEOUT_MS = 45_000;

export function assistPrompt(text: string, projects: string[]): string {
	return [
		"You are the intent reader for Tower, a board where coding work is planned and built by agents. A person typed one line into the board's command box; decide what they want done.",
		"",
		`Projects on this board: ${projects.join(", ")}`,
		`Their line: ${JSON.stringify(text)}`,
		"",
		'A "@name" in the line tags the project the work belongs to; prefer it over guessing.',
		'Reply with ONE JSON object and nothing else — no prose, no code fence:',
		'{"action":"add_card" | "start_card" | "none","project":"<name from the list, or \\"\\">","title":"<short imperative title, at most 80 characters>","brief":"<one or two sentences of context for the planner, or \\"\\">"}',
		'"add_card" puts new work on the backlog. "start_card" adds it and begins planning right away. If the line is not a request for new work — a question, a greeting, a change to an existing card — reply {"action":"none","project":"","title":"","brief":""}.',
	].join("\n");
}

/** Pulls the verdict out of the model's reply, tolerating a stray sentence or code fence around it. */
export function parseVerdict(text: string): AssistVerdict | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const raw = JSON.parse(text.slice(start, end + 1)) as Partial<AssistVerdict>;
		if (raw.action !== "add_card" && raw.action !== "start_card" && raw.action !== "none") return null;
		return {
			action: raw.action,
			project: typeof raw.project === "string" ? raw.project.trim() : "",
			title: typeof raw.title === "string" ? raw.title.trim().slice(0, 120) : "",
			brief: typeof raw.brief === "string" ? raw.brief.trim().slice(0, 2000) : "",
		};
	} catch {
		return null;
	}
}

/** Tower's own reading of the @tag, independent of the model: exact project-name match, case-insensitive. */
export function taggedProject(text: string, projects: Array<{ id: string; name: string }>): { id: string; name: string } | null {
	const tag = text.match(/@([\w.-]+)/)?.[1]?.toLowerCase();
	if (!tag) return null;
	return projects.find((project) => project.name.toLowerCase() === tag) ?? null;
}

/** The named project, or null when the name matches nothing on the board. */
export function matchProject(name: string, projects: Array<{ id: string; name: string }>): { id: string; name: string } | null {
	if (!name) return null;
	const lower = name.toLowerCase();
	return projects.find((project) => project.name.toLowerCase() === lower) ?? null;
}

/**
 * One cheap, tool-less session with no card attached: it reads the person's line and replies with a
 * verdict Tower can act on. This run stays out of the runs table (there is no card to hold it); its
 * transcript lands under <home>/assist. Throws on a malformed reply, a dead session or a timeout —
 * the caller decides the fallback.
 */
export async function readIntent(options: { config: Config; driver: SessionDriver; text: string; projects: Array<{ id: string; name: string }> }): Promise<AssistVerdict> {
	const { config, driver } = options;
	// The cheapest tier judges builds; it can certainly tag a line of text.
	const model = resolveStageConfig("testing", { global: config.globalStageConfig });
	const sessionId = `assist-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
	const sessionDir = join(config.home, "assist", sessionId, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const spec: RunSpec = { sessionId, cwd: config.home, sessionDir, model: model.model, thinking: "off", tools: [], extensions: [], trustProject: false, appendSystemPromptFiles: [] };
	const handle = await driver.start(spec);
	let reply = "";
	const off = handle.onEvent((event) => {
		if (event.type === "message" && event.message.role === "assistant" && event.message.text.trim()) reply = event.message.text;
	});
	try {
		await handle.prompt(assistPrompt(options.text, options.projects.map((project) => project.name)));
		let timedOut = false;
		await Promise.race([
			handle.waitSettled(),
			new Promise((_, reject) => {
				const timer = setTimeout(() => {
					timedOut = true;
					reject(new Error("the intent session timed out"));
				}, ASSIST_TIMEOUT_MS);
				timer.unref();
			}),
		]).catch((error) => {
			throw timedOut ? error : new Error(`the intent session died: ${error instanceof Error ? error.message : String(error)}`);
		});
	} finally {
		await handle.stop().catch(() => {});
		off();
	}
	const verdict = parseVerdict(reply);
	if (!verdict) throw new Error(`the intent session did not return a verdict`);
	return verdict;
}
