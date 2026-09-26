export const STAGES = ["backlog", "planning", "building", "testing", "feedback", "pull_request", "done"] as const;
export type Stage = (typeof STAGES)[number];

/** Stages that are executed by a pi session. */
export type AgentStage = "planning" | "building" | "testing";

export type CardStatus =
	| "idle"
	| "queued"
	| "running"
	| "verifying"
	| "awaiting_gate"
	| "awaiting_input"
	| "needs_attention"
	| "paused"
	| "interrupted"
	| "abandoned";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** "test" is a person's on-demand run of the project's test command; "verify" is Tower's own gate.
 *  "subagent" is one member of a card's crew: a scout, a stream builder or the integrator. */
export type RunKind = "stage" | "verify" | "test" | "flow_step" | "adhoc" | "subagent";
export type RunStatus = "starting" | "running" | "settled" | "interrupted" | "failed" | "aborted";
export type ResultStatus = "pass" | "fail" | "blocked" | "missing";

export interface Project {
	id: string;
	name: string;
	repoPath: string;
	defaultBranch: string;
	setupCommand: string | null;
	verifyCommand: string | null;
	/** A hands-on test command, run on demand from a card. Never gates the lifecycle. */
	testCommand: string | null;
	/** A long-running dev server, started and stopped from a card. */
	previewCommand: string | null;
	/** Where the preview becomes usable, opened from the card while the preview runs. */
	previewUrl: string | null;
	/** Run after the preview starts: exits 0 when the URL is really serving this app. A preview that passes its check is trusted; one that fails is reported degraded instead of silently wrong. */
	previewCheck: string | null;
	/** The most one card may spend on agent sessions before the pipeline pauses for a person. null: unbudgeted. */
	budgetUsd: number | null;
	/** Run the after-tests review flows at the same time. null = Tower's default (sequential). */
	parallelReviews: boolean | null;
	trustProjectPi: boolean;
	extensions: string[];
	concurrencyLimit: number;
	stageConfig: StageConfigOverrides;
	/** Review flows run after tests pass. null = Tower's default set; [] = none. */
	reviewFlows: string[] | null;
	/** Invariant simulation in planning and testing. null = Tower's default. */
	invariantSimulation: boolean | null;
	/** Parallel sub-agents: scouts and stream crews fanned out from the plan. null = Tower's default. */
	subagents: boolean | null;
	/** Before planning, (re)build the project's system model when it is missing or stale. null = Tower's default. */
	understandBeforePlan: boolean | null;
	/** Plans must name test targets that become failing acceptance tests before building and passing ones after. null = Tower's default. */
	acceptanceGates: boolean | null;
	/** Probed from the repository: with an `origin` remote cards finish as pull requests, without one Tower merges locally. null = not probed yet. */
	hasOrigin: boolean | null;
	/** Pinned sources — repository paths or URLs (internal docs, design notes, past briefs) — that research steps read before searching the network. */
	sources: string[];
	createdAt: number;
}

export interface Card {
	id: string;
	projectId: string;
	title: string;
	brief: string;
	stage: Stage;
	status: CardStatus;
	priority: number;
	position: number;
	branchName: string | null;
	worktreePath: string | null;
	baseCommit: string | null;
	attempt: number;
	stageConfig: StageConfigOverrides;
	prUrl: string | null;
	prState: string | null;
	needsAttentionReason: string | null;
	/** How the work ended, for a done card: merged locally, PR merged. An outcome, never an attention reason. */
	finishNote: string | null;
	/** Stacked on another card: this card's branch starts from that card's branch, so it builds on unmerged work. */
	baseCardId: string | null;
	/** This card waits for that card to land before it is worth a slot; scheduling skips it until then. */
	dependsOn: string | null;
	/** The GitHub issue this card came from, when intake filed it from the feedback repo. */
	issueUrl: string | null;
	issueNumber: number | null;
	issueAuthor: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface StageRun {
	id: string;
	cardId: string;
	kind: RunKind;
	stage: Stage;
	attempt: number;
	model: string;
	thinking: ThinkingLevel;
	args: string[];
	status: RunStatus;
	resultStatus: ResultStatus | null;
	resultSummary: string | null;
	/** What the stage asked, when it stopped to ask. */
	questions: Array<{ question: string; options: string[] }> | null;
	tokens: TokenUsage | null;
	costUsd: number | null;
	lastEntryId: string | null;
	startedAt: number;
	endedAt: number | null;
	error: string | null;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** A margin note a person pinned to text on a card — the plan, a review, a report. */
export interface Annotation {
	id: string;
	/** The artifact the note is pinned to, e.g. `plan.md` or `reviews/adversarial-review.md`. */
	artifact: string;
	/** The exact text the note is about. */
	quote: string;
	note: string;
	/** Resolved notes drop out of the agents' way but stay on the record. */
	resolved: boolean;
	createdAt: number;
}

/** A research question asked with no project yet: the deep-research steps run where it stands, and
 *  promotion files the brief as a card in whichever project the person picks. */
export type ResearchStatus = "open" | "running" | "brief" | "promoted";

export interface ResearchQuestion {
	id: string;
	question: string;
	status: ResearchStatus;
	/** The step in flight while running: the survey gathers evidence, then the synthesizer writes the brief. */
	step: "survey" | "brief" | null;
	/** The cited brief, once the synthesizer has written it. */
	brief: string | null;
	promotedCardId: string | null;
	promotedProjectId: string | null;
	createdAt: number;
}

export interface StageModelConfig {
	model: string;
	thinking: ThinkingLevel;
}

/** Partial per-stage overrides, stored on projects and cards. Precedence: card > project > global > stage default. */
export type StageConfigOverrides = Partial<Record<AgentStage, Partial<StageModelConfig>>>;

/** Everything the session driver needs to spawn one pi session. The pi-specific translation lives in the daemon. */
export interface RunSpec {
	sessionId: string;
	cwd: string;
	sessionDir: string;
	model: string;
	thinking: ThinkingLevel;
	tools: string[];
	extensions: string[];
	trustProject: boolean;
	appendSystemPromptFiles: string[];
}
