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
	/** Review flows shipped with Tower. The person's own live in <home>/flows. */
	flowsDir: string;
	/** Review flows a project runs after its tests pass. null (env unset): discover — every flow with the after-tests trigger runs; []: none. */
	defaultReviewFlows: string[] | null;
	/** Whether planning and testing use the invariant-simulation protocol, unless a project says otherwise. */
	invariantSimulation: boolean;
	/** Whether plans may fan out to scouts and parallel stream builders, unless a project says otherwise. */
	subagents: boolean;
	/** Whether a project's system model is (re)built before planning when missing or stale, unless a project says otherwise. */
	understandBeforePlan: boolean;
	/** Whether plans must carry test targets that gate as failing acceptance tests before building and passing ones after, unless a project says otherwise. */
	acceptanceGates: boolean;
	/** Where the archetype templates live: the engineering baselines a new project can be scaffolded from. */
	archetypesDir: string;
	/** How many of a card's scouts or stream builders may run at once. */
	maxCrew: number;
	/** How often open pull requests are checked, and how many times a failing one is repaired before asking. */
	prPollMs: number;
	/** Where board feedback is filed as issues, and whose issues come back as backlog cards ("owner/name"). */
	feedbackRepo: string;
	/** How often the feedback repo's open issues are checked for ones without a card yet. 0 turns intake off. */
	issuesPollMs: number;
	maxCiFixAttempts: number;
	/** How long a blocking question from a pi extension may wait for an answer before it is cancelled. */
	uiRequestTimeoutMs: number;
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

export const repoRoot = join(import.meta.dirname, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const home = env.TOWER_HOME ?? join(homedir(), ".tower");
	return {
		home,
		// Single-user tool with no auth: never bind anything but loopback.
		host: "127.0.0.1",
		port: Number(env.TOWER_PORT ?? 4700),
		promptsDir: env.TOWER_PROMPTS_DIR ?? join(repoRoot, "prompts"),
		flowsDir: env.TOWER_FLOWS_DIR ?? join(repoRoot, "flows"),
		// Unset means discovery: the flows that ask for the after-tests trigger themselves (the shipped reviews do).
		// Set but empty means off — an explicit choice, not a request to go discover.
		defaultReviewFlows: env.TOWER_REVIEW_FLOWS !== undefined ? env.TOWER_REVIEW_FLOWS.split(",").map((name) => name.trim()).filter(Boolean) : null,
		invariantSimulation: !["0", "false"].includes((env.TOWER_INVARIANT_SIMULATION ?? "").toLowerCase()),
		subagents: !["0", "false"].includes((env.TOWER_SUBAGENTS ?? "").toLowerCase()),
		understandBeforePlan: !["", "0", "false"].includes((env.TOWER_UNDERSTAND_BEFORE_PLAN ?? "").toLowerCase()),
		acceptanceGates: !["", "0", "false"].includes((env.TOWER_ACCEPTANCE_GATES ?? "").toLowerCase()),
		archetypesDir: env.TOWER_ARCHETYPES_DIR ?? join(repoRoot, "archetypes"),
		maxCrew: Number(env.TOWER_MAX_CREW ?? 3),
		prPollMs: Number(env.TOWER_PR_POLL_MS ?? 120_000),
		feedbackRepo: env.TOWER_FEEDBACK_REPO ?? "rahult/tower",
		issuesPollMs: Number(env.TOWER_ISSUES_POLL_MS ?? 180_000),
		maxCiFixAttempts: Number(env.TOWER_MAX_CI_FIX_ATTEMPTS ?? 2),
		uiRequestTimeoutMs: Number(env.TOWER_UI_REQUEST_TIMEOUT_MS ?? 5 * 60_000),
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
	/** A project's derived knowledge: its system model and the stamp saying which commit it describes. */
	projectDir: (config: Config, projectId: string) => join(config.home, "projects", projectId),
	systemModel: (config: Config, projectId: string) => join(config.home, "projects", projectId, "system-model.md"),
	systemModelMeta: (config: Config, projectId: string) => join(config.home, "projects", projectId, "system-model.json"),
	/** Where scaffolded repositories live when a project is created from an idea rather than added from disk. */
	repos: (config: Config) => join(config.home, "repos"),
};
