import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveStageConfig, type RunSpec } from "@tower/core";
import { type Config } from "./config.ts";
import { parseFlow, type Flow } from "./flows.ts";
import type { SessionDriver } from "./pi/session-driver.ts";

const TIMEOUT_MS = 120_000;
/** One retry: the validator's complaint goes back to the same session before the person sees a failure. */
const MAX_ATTEMPTS = 2;
const PLAN_CHARS_MAX = 40_000;

export interface ComposeInput {
	projectName: string;
	cardTitle: string;
	brief: string;
	plan?: string | null;
	verifyCommand?: string | null;
	testCommand?: string | null;
	/** A backlog card has no worktree: the draft may only read. */
	readOnly?: boolean;
}

export function composeFlowPrompt(input: ComposeInput): string {
	const commands = [
		input.verifyCommand ? `- verify (the merge gate): \`${input.verifyCommand}\`` : null,
		input.testCommand ? `- test (hands-on check): \`${input.testCommand}\`` : null,
	]
		.filter(Boolean)
		.join("\n");
	return [
		`You are the process designer for Tower, a board where coding agents build one card at a time and deterministic gates keep them honest. Design a flow for the task below: a small state machine of steps the task should pass through before it is called done. Match the discipline to the task — a one-line copy fix wants one gate, a risky migration wants a fix-then-recheck loop.`,
		"",
		`Task: "${input.cardTitle}" on the project "${input.projectName}"`,
		"",
		"Brief:",
		"",
		input.brief || "(none)",
		...(input.plan && input.plan.trim() ? ["", "Plan:", "", input.plan.trim()] : []),
		...(commands ? ["", "The project's commands:", "", commands] : []),
		"",
		"How to design it:",
		"- Between 2 and 7 steps. Reply with ONE JSON object and nothing else — no prose, no code fence — shaped exactly like this:",
		'{"name":"<lower-case-dashes>","title":"<Human title>","description":"<one sentence: what this process guards>","when":["manual"],"steps":[{"name":"<lower-case-dashes>","run":"<shell command>"}]}',
		'- Every step has exactly ONE of: "run" (a shell command — deterministic, no model, the exit code is the verdict; this is a gate), "text" (inline instructions for an agent step — a model session that reads the code and returns a pass/fail verdict), "skill" (a pi skill name), or "agent" (a saved agent role name). Reference the context where it helps: {{title}}, {{brief}}, {{worktreePath}}, {{branchName}} work in "run" commands and "text".',
		'- Bound non-deterministic work with deterministic gates: an agent step that claims something should be proved by a "run" step (the project\'s real commands when they fit). A claim without a check is not discipline.',
		'- Route failure with edges instead of dead-ending: "on":{"pass":"<step>","fail":"<step>"} on a step names where each verdict goes. A missing edge falls through to the next step in order; the last step needs none. The repair loop — a gate fails to a fix step whose pass returns to the gate — is the pattern for anything fixable; cap the fix step with "maxRuns":2 so the loop can lose.',
		"- Scale the depth to the risk: every step must earn its keep. One honest sentence in the description.",
		...(input.readOnly ? ["", "This task has not started yet (a backlog card, no worktree): do not use \"run\" steps, and give agent steps only \"access\":\"read-only\" or \"read-and-run\"."] : []),
	].join("\n");
}

/**
 * One tool-less session: the task's brief and plan go in, a drafted flow (a state machine of
 * deterministic and agent steps) comes out. Nothing saves itself — the person sees the draft first.
 */
export async function composeFlow(options: { config: Config; driver: SessionDriver } & ComposeInput): Promise<Flow> {
	const { config, driver, ...input } = options;
	const brief = input.brief.trim().slice(0, 4000);
	const plan = input.plan?.trim().slice(0, PLAN_CHARS_MAX) || null;
	if (!brief && !plan) throw new Error("That task has nothing to design from — give the card a brief or a plan first");

	// Designing process is planning-shaped work: it wants the strong tier, not the cheap one.
	const model = resolveStageConfig("planning", { global: config.globalStageConfig });
	const sessionId = `flow-compose-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
	const sessionDir = join(config.home, "flow-compose", sessionId, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const spec: RunSpec = { sessionId, cwd: config.home, sessionDir, model: model.model, thinking: model.thinking, tools: [], extensions: [], trustProject: false, appendSystemPromptFiles: [] };
	const handle = await driver.start(spec);
	let reply = "";
	const off = handle.onEvent((event: { type: string; message?: { role: string; text?: string } }) => {
		if (event.type === "message" && event.message?.role === "assistant" && event.message.text?.trim()) reply = event.message.text;
	});
	try {
		await handle.prompt(composeFlowPrompt({ ...input, brief, plan }));
		for (let attempt = 1; ; attempt++) {
			let timedOut = false;
			await Promise.race([
				handle.waitSettled(),
				new Promise<never>((_, reject) => {
					const timer = setTimeout(() => {
						timedOut = true;
						reject(new Error("the flow-design session timed out"));
					}, TIMEOUT_MS);
					timer.unref();
				}),
			]).catch((error) => {
				throw timedOut ? error : new Error(`the flow-design session died: ${error instanceof Error ? error.message : String(error)}`);
			});
			try {
				return parseFlowDraft(reply);
			} catch (error) {
				if (attempt >= MAX_ATTEMPTS) throw error;
				const rejection = error instanceof Error ? error.message : String(error);
				reply = "";
				await handle.prompt(`That JSON was rejected: ${rejection}\n\nReply again with ONE corrected JSON object and nothing else.`);
			}
		}
	} finally {
		await handle.stop().catch(() => {});
		off();
	}
}

/** Pulls the drafted flow out of the model's reply and holds it to Tower's own validation. */
export function parseFlowDraft(reply: string): Flow {
	const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
	return parseFlow(json, "the drafted flow");
}
