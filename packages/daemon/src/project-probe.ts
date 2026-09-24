import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { resolveStageConfig, type RunSpec } from "@tower/core";
import { type Config } from "./config.ts";
import type { SessionDriver } from "./pi/session-driver.ts";

export interface CommandSuggestions {
	verify: string | null;
	test: string | null;
	setup: string | null;
	previewCommand: string | null;
	previewUrl: string | null;
}

const TIMEOUT_MS = 60_000;
const FACT_CAP = 3500;

/**
 * The facts an agent needs to configure a repository, gathered without a model: the files that
 * declare how a project builds, tests and runs. Anything unreadable is simply left out.
 */
export function gatherRepoFacts(repoPath: string): Record<string, unknown> {
	const facts: Record<string, unknown> = { path: repoPath, entries: [] };
	try {
		facts.entries = readdirSync(repoPath).filter((name) => !name.startsWith(".")).slice(0, 40);
	} catch {
		// The listing is a nicety; the named files below still get read.
	}
	const pkg = join(repoPath, "package.json");
	if (existsSync(pkg)) {
		try {
			const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; packageManager?: string; scripts?: Record<string, string> };
			facts.packageName = parsed.name;
			facts.packageManager = parsed.packageManager;
			facts.scripts = parsed.scripts ?? {};
		} catch {
			facts.packageJson = "present but unparseable";
		}
	}
	for (const marker of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Makefile", "composer.json", "Gemfile"]) {
		if (existsSync(join(repoPath, marker))) facts[marker] = true;
	}
	// Script contents are what the agent reasons over; cap them so a huge package.json cannot flood the prompt.
	if (typeof facts.scripts === "object") {
		const scripts = JSON.stringify(facts.scripts);
		if (scripts.length > FACT_CAP) facts.scripts = "present, too large to include";
	}
	return facts;
}

export function suggestPrompt(facts: Record<string, unknown>): string {
	return [
		"You are configuring Tower for the repository summarised by this JSON:",
		JSON.stringify(facts, null, 2),
		"",
		"Determine four shell commands for this repository, in its own package manager and test runner:",
		'- "verify": runs the whole test suite and exits non-zero when it fails (the command CI would run).',
		'- "test": a convenient one-shot run of the tests for a developer.',
		'- "setup": prepares a fresh checkout (install dependencies).',
		'- "previewCommand" and "previewUrl": how to start its dev server and the URL it answers on, null if there is none.',
		"Use null for anything the repository does not support. Reply with ONLY the JSON object",
		'{"verify": string | null, "test": string | null, "setup": string | null, "previewCommand": string | null, "previewUrl": string | null}',
	].join("\n");
}

/** One cheap, tool-less session: the repository's facts go in, the commands come back as JSON. */
export async function suggestCommands(options: { config: Config; driver: SessionDriver; repoPath: string }): Promise<CommandSuggestions> {
	const { config, driver, repoPath } = options;
	// The cheapest tier is enough: the hard part is the daemon's file reading, not the choice of verb.
	const model = resolveStageConfig("testing", { global: config.globalStageConfig });
	const sessionId = `suggest-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
	const sessionDir = join(config.home, "suggest", sessionId, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const spec: RunSpec = { sessionId, cwd: repoPath, sessionDir, model: model.model, thinking: "off", tools: [], extensions: [], trustProject: false, appendSystemPromptFiles: [] };
	const handle = await driver.start(spec);
	let reply = "";
	const off = handle.onEvent((event: { type: string; message?: { role: string; text?: string } }) => {
		if (event.type === "message" && event.message?.role === "assistant" && event.message.text?.trim()) reply = event.message.text;
	});
	try {
		await handle.prompt(suggestPrompt(gatherRepoFacts(repoPath)));
		let timedOut = false;
		await Promise.race([
			handle.waitSettled(),
			new Promise<never>((_, reject) => {
				const timer = setTimeout(() => {
					timedOut = true;
					reject(new Error("the command probe timed out"));
				}, TIMEOUT_MS);
				timer.unref();
			}),
		]).catch((error) => {
			throw timedOut ? error : new Error(`the command probe died: ${error instanceof Error ? error.message : String(error)}`);
		});
	} finally {
		await handle.stop().catch(() => {});
		off();
	}

	const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("the agent did not return usable commands — try again or fill them in by hand");
	}
	const pick = (key: string): string | null => {
		const value = (parsed as Record<string, unknown>)[key];
		return typeof value === "string" && value.trim() ? value.trim() : null;
	};
	return { verify: pick("verify"), test: pick("test"), setup: pick("setup"), previewCommand: pick("previewCommand"), previewUrl: pick("previewUrl") };
}
