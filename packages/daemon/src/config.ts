import { homedir } from "node:os";
import { join } from "node:path";
import type { StageConfigOverrides } from "@tower/core";
import { readModels } from "./settings.ts";

export interface Config {
	/** Data root: database, card folders and worktrees. */
	home: string;
	host: string;
	port: number;
	promptsDir: string;
	/** Built web UI served in production; absent in dev (Vite proxies to the daemon instead). */
	webDist: string;
	/** Which model runs each stage, from <home>/config.json. Replaced at runtime when settings are saved. */
	globalStageConfig: StageConfigOverrides;
	/** Sessions and verify commands that may run at once, across all projects. */
	maxConcurrent: number;
	/** Builds allowed per card before a failing test stops the loop and asks the human. */
	maxBuildAttempts: number;
	verifyTimeoutMs: number;
}

const repoRoot = join(import.meta.dirname, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const home = env.TOWER_HOME ?? join(homedir(), ".tower");
	return {
		home,
		// Single-user tool with no auth: never bind anything but loopback.
		host: "127.0.0.1",
		port: Number(env.TOWER_PORT ?? 4700),
		promptsDir: env.TOWER_PROMPTS_DIR ?? join(repoRoot, "prompts"),
		webDist: env.TOWER_WEB_DIST ?? join(repoRoot, "packages", "web", "dist"),
		globalStageConfig: readModels(home),
		maxConcurrent: Number(env.TOWER_MAX_CONCURRENT ?? 3),
		maxBuildAttempts: Number(env.TOWER_MAX_BUILD_ATTEMPTS ?? 3),
		verifyTimeoutMs: Number(env.TOWER_VERIFY_TIMEOUT_MS ?? 20 * 60_000),
	};
}

export const paths = {
	db: (config: Config) => join(config.home, "tower.sqlite"),
	cardDir: (config: Config, cardId: string) => join(config.home, "cards", cardId),
	sessionDir: (config: Config, cardId: string) => join(config.home, "cards", cardId, "sessions"),
	worktree: (config: Config, projectId: string, cardId: string) => join(config.home, "worktrees", projectId, cardId),
};
