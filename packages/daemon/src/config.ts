import { homedir } from "node:os";
import { join } from "node:path";
import type { StageConfigOverrides } from "@traffic-control/core";

export interface Config {
	/** Data root: database, card folders and worktrees. */
	home: string;
	host: string;
	port: number;
	promptsDir: string;
	/** Built web UI served in production; absent in dev (Vite proxies to the daemon instead). */
	webDist: string;
	globalStageConfig: StageConfigOverrides;
	/** Sessions and verify commands that may run at once, across all projects. */
	maxConcurrent: number;
	/** Builds allowed per card before a failing test stops the loop and asks the human. */
	maxBuildAttempts: number;
	verifyTimeoutMs: number;
}

const repoRoot = join(import.meta.dirname, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	return {
		home: env.TC_HOME ?? join(homedir(), ".traffic-control"),
		// Single-user tool with no auth: never bind anything but loopback.
		host: "127.0.0.1",
		port: Number(env.TC_PORT ?? 4700),
		promptsDir: env.TC_PROMPTS_DIR ?? join(repoRoot, "prompts"),
		webDist: env.TC_WEB_DIST ?? join(repoRoot, "packages", "web", "dist"),
		globalStageConfig: {},
		maxConcurrent: Number(env.TC_MAX_CONCURRENT ?? 3),
		maxBuildAttempts: Number(env.TC_MAX_BUILD_ATTEMPTS ?? 3),
		verifyTimeoutMs: Number(env.TC_VERIFY_TIMEOUT_MS ?? 20 * 60_000),
	};
}

export const paths = {
	db: (config: Config) => join(config.home, "tc.sqlite"),
	cardDir: (config: Config, cardId: string) => join(config.home, "cards", cardId),
	sessionDir: (config: Config, cardId: string) => join(config.home, "cards", cardId, "sessions"),
	worktree: (config: Config, projectId: string, cardId: string) => join(config.home, "worktrees", projectId, cardId),
};
