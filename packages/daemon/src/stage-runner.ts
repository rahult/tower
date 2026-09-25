import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentStage,
	type Card,
	type CrewPlan,
	hasCrew,
	parseCrewPlan,
	type Project,
	type ResultStatus,
	type RunSpec,
	type StageRun,
	type ThinkingLevel,
	parseStageResult,
	pickModel,
	renderPrompt,
	resolveStageConfig,
	sessionIdFor,
	STAGE_RESULT_FILE,
	STAGE_SPECS,
} from "@tower/core";
import { type Config, paths } from "./config.ts";
import type { CrewContext } from "./crew-runner.ts";
import type { Db } from "./db/open.ts";
import { getCard, updateCard } from "./db/repo-cards.ts";
import { getProject } from "./db/repo-projects.ts";
import { countRunsForStage, getRun, insertRun, listRunsForCard, type RunPatch, updateRun } from "./db/repo-runs.ts";
import type { Bus } from "./events/bus.ts";
import { runSetup } from "./git/setup.ts";
import { branchNameFor, ensureWorktree, type Worktree } from "./git/worktree-manager.ts";
import { buildPiArgs } from "./pi/argv.ts";
import type { LiveRun, RunManager } from "./run/run-manager.ts";
import { readModelMeta } from "./system-model.ts";
import { unresolvedAnnotationsBlock } from "./annotations.ts";

const RESUME = `You were interrupted by a restart of the orchestrator; nothing else changed. Check the state of your work, then continue the task from where you left off. Your original instructions still apply, including writing ${STAGE_RESULT_FILE} when you are done.`;

const NUDGE = `You stopped without writing the required result file. Write ${STAGE_RESULT_FILE} now, exactly as specified in your instructions, then stop.`;

/** How a stage run ended. The orchestrator turns this into a card transition. */
export type RunOutcome =
	| { kind: "settled"; stage: AgentStage; result: ResultStatus; summary: string; hasQuestions: boolean }
	| { kind: "failed"; error: string }
	| { kind: "aborted" };

/** A session that is not a card stage: a review-flow step, an ad hoc run, or a crew member. */
export interface CustomRun {
	sessionId: string;
	kind: "flow_step" | "adhoc" | "subagent";
	attempt: number;
	model: string;
	thinking: ThinkingLevel;
	tools: string[];
	prompt: string;
	appendSystemPromptFiles?: string[];
	/** Whether the session must end by writing its result file. */
	requireResult: boolean;
	/** Crew members hold the card's lease together with their crew instead of alone. */
	shared?: boolean;
	/** Where the result is expected, relative to the card's folder. Default: the stage result file. */
	resultPath?: string;
	/** Where the session works. Default: the card's worktree; a stream builder gets its own. */
	cwd?: string;
}

export interface StageRunnerDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
	/** Late-bound crew runner: scouts and stream builders are driven through this runner's own startCustom. */
	crew: { run: (ctx: CrewContext) => Promise<RunOutcome> };
	/** Called synchronously once the session is up, before any work is driven, so it always precedes onOutcome. */
	onStarted: (cardId: string) => void;
	onOutcome: (cardId: string, outcome: RunOutcome) => void;
}

/** Executes one agent stage for a card: worktree, prompt, session, result validation, bookkeeping. */
export class StageRunner {
	private readonly deps: StageRunnerDeps;
	private readonly aborts = new Map<string, () => void>();
	/** Settles when the background work of a run is finished. Tests and shutdown await these. */
	readonly inFlight = new Map<string, Promise<void>>();
	private stopping = false;

	/**
	 * The daemon is shutting down: sessions are about to be killed. Record nothing about how they end, so the
	 * runs stay "running" in the database and the next boot marks them interrupted and offers to resume them.
	 */
	beginShutdown(): void {
		this.stopping = true;
	}

	constructor(deps: StageRunnerDeps) {
		this.deps = deps;
	}

	/** Starts the stage and returns once the session is up. The stage itself continues in the background. */
	async start(cardId: string, stage: AgentStage, options: { feedback?: string; fixingCi?: boolean } = {}): Promise<StageRun> {
		const { config, db, runs } = this.deps;
		const card = getCard(db, cardId);
		if (!card) throw new Error(`Card not found: ${cardId}`);
		const project = getProject(db, card.projectId);
		if (!project) throw new Error(`Project not found: ${card.projectId}`);
		if (runs.liveRunForCard(cardId)) throw new Error("This card already has a running session");

		// A stacked card branches from its base card's branch, so it builds on unmerged work; when that
		// branch is gone (the base finished and its branch was deleted), the default branch is the base.
		let baseBranch = project.defaultBranch;
		if (card.baseCardId) {
			const stackOn = getCard(db, card.baseCardId)?.branchName;
			if (stackOn) {
				try {
					execFileSync("git", ["rev-parse", "--verify", stackOn], { cwd: project.repoPath, stdio: "pipe" });
					baseBranch = stackOn;
				} catch {
					// the base's branch is gone (finished and cleaned up); the default branch is the base
				}
			}
		}
		const worktree = await ensureWorktree({
			repoPath: project.repoPath,
			path: card.worktreePath ?? paths.worktree(config, project.id, card.id),
			branchName: card.branchName ?? branchNameFor(card.id, card.title),
			baseBranch,
		});
		// A fresh worktree has no node_modules, venv or build cache; the project says how to make it usable.
		if (worktree.created && project.setupCommand) await runSetup(project.setupCommand, worktree.path);
		const cardDir = paths.cardDir(config, card.id);
		mkdirSync(paths.sessionDir(config, card.id), { recursive: true });
		// A stale result from an earlier stage must never be read as this stage's verdict.
		rmSync(join(cardDir, STAGE_RESULT_FILE), { force: true });

		const attempt = countRunsForStage(db, card.id, stage) + 1;

		// A crew fans the build out only from the plan, only in building, and only when a CI repair — a single
		// targeted fix — is not what is being asked for.
		let crew: CrewPlan = { scouts: [], streams: [] };
		if (stage === "building" && !options.fixingCi && (project.subagents ?? config.subagents)) {
			const planFile = join(paths.cardDir(config, card.id), "plan.md");
			const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : "";
			crew = parseCrewPlan(plan);
		}
		if (hasCrew(crew)) return this.startCrew(card, project, attempt, worktree, crew, options.feedback);

		const spec = this.buildSpec(card, project, stage, attempt, worktree.path);
		// A build that repairs a failing pull request is told apart from ordinary builds by its session id.
		if (options.fixingCi) spec.sessionId = `c${card.id}-cifix-${attempt}`;
		const feedback = options.fixingCi && options.feedback ? `This work is already in a pull request, and its CI checks are failing. Fix the cause, commit, and do not weaken the checks.\n\n${options.feedback}` : options.feedback;
		// Render before anything is spawned: a prompt that cannot render (new prompt files meeting an older
		// daemon, say mid-update) must fail the run cleanly, not leave a spawned session undriven.
		const prompt = this.renderStagePrompt(card, project, stage, worktree.path, worktree.branchName, worktree.baseCommit, feedback);
		const run: StageRun = {
			id: spec.sessionId,
			cardId: card.id,
			kind: "stage",
			stage,
			attempt,
			model: spec.model,
			thinking: spec.thinking,
			args: buildPiArgs(spec),
			status: "starting",
			resultStatus: null,
			resultSummary: null,
			questions: null,
			tokens: null,
			costUsd: null,
			lastEntryId: null,
			startedAt: Date.now(),
			endedAt: null,
			error: null,
		};
		insertRun(db, run);
		this.patchCard(card.id, { attempt, worktreePath: worktree.path, branchName: worktree.branchName, baseCommit: worktree.baseCommit });

		let live: LiveRun;
		try {
			live = await runs.start(card.id, spec);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.patchRun(run.id, { status: "failed", error: message, endedAt: Date.now() });
			throw error;
		}
		this.patchRun(run.id, { status: "running" });
		this.deps.onStarted(card.id);

		const work = this.drive(live, stage, prompt, cardDir).finally(() => this.inFlight.delete(run.id));
		this.inFlight.set(run.id, work);
		return getRun(db, run.id) as StageRun;
	}

	/**
	 * The building attempt the plan split into a crew: one marker row stands for the attempt (the lifecycle's
	 * attempt counter and the drawer's rail both read it), while the members — scouts, builders, integrator —
	 * run as their own recorded sessions. The crew's combined verdict settles the marker and the card alike.
	 */
	private async startCrew(card: Card, project: Project, attempt: number, worktree: Worktree, crew: CrewPlan, feedback?: string): Promise<StageRun> {
		const { db, config } = this.deps;
		const cardDir = paths.cardDir(config, card.id);
		const fallbackPrompt = this.renderStagePrompt(card, project, "building", worktree.path, worktree.branchName, worktree.baseCommit, feedback);
		const run: StageRun = {
			id: sessionIdFor(card.id, "building", attempt),
			cardId: card.id,
			kind: "stage",
			stage: "building",
			attempt,
			model: "crew",
			thinking: "off",
			args: ["crew", String(crew.streams.length)],
			status: "running",
			resultStatus: null,
			resultSummary: null,
			questions: null,
			tokens: null,
			costUsd: null,
			lastEntryId: null,
			startedAt: Date.now(),
			endedAt: null,
			error: null,
		};
		insertRun(db, run);
		this.patchCard(card.id, { attempt, worktreePath: worktree.path, branchName: worktree.branchName, baseCommit: worktree.baseCommit });
		this.deps.onStarted(card.id);

		const work = this.deps.crew
			.run({ card, project, attempt, worktree, crew, ...(feedback ? { feedback } : {}), fallbackPrompt })
			.then((outcome) => {
				if (this.stopping) return;
				if (outcome.kind === "settled") {
					this.patchRun(run.id, { status: "settled", resultStatus: outcome.result, resultSummary: outcome.summary, questions: outcome.hasQuestions ? (listRunsForCard(db, card.id).findLast((member) => member.questions)?.questions ?? null) : null, endedAt: Date.now() });
				} else if (outcome.kind === "failed") {
					this.patchRun(run.id, { status: "failed", error: outcome.error, endedAt: Date.now() });
				} else {
					this.patchRun(run.id, { status: "aborted", endedAt: Date.now() });
				}
				this.deps.onOutcome(card.id, outcome);
			})
			.finally(() => this.inFlight.delete(run.id));
		this.inFlight.set(run.id, work);
		return getRun(db, run.id) as StageRun;
	}

	/**
	 * Runs a session that is not one of the card's stages: a review-flow step or something the person asked for.
	 * It holds the card's lease like any session and streams like one, but its outcome goes to the caller, not to
	 * the card's lifecycle. Resolves when the session has finished.
	 */
	async startCustom(cardId: string, request: CustomRun): Promise<RunOutcome> {
		const { config, db, runs } = this.deps;
		const card = getCard(db, cardId);
		const project = card && getProject(db, card.projectId);
		if (!card || !project) throw new Error(`Card not found: ${cardId}`);
		// A card with no worktree yet (research on a backlog card) works straight in the project checkout.
		const cwd = request.cwd ?? card.worktreePath ?? project.repoPath;
		const cardDir = paths.cardDir(config, card.id);
		const resultFile = request.resultPath ?? STAGE_RESULT_FILE;
		mkdirSync(join(cardDir, "reviews"), { recursive: true });
		if (request.requireResult) rmSync(join(cardDir, resultFile), { force: true });

		const spec: RunSpec = {
			sessionId: request.sessionId,
			cwd,
			sessionDir: paths.sessionDir(config, card.id),
			model: request.model,
			thinking: request.thinking,
			tools: request.tools,
			extensions: project.extensions,
			trustProject: project.trustProjectPi,
			appendSystemPromptFiles: request.appendSystemPromptFiles ?? [],
		};
		insertRun(db, {
			id: spec.sessionId,
			cardId: card.id,
			kind: request.kind,
			stage: card.stage,
			attempt: request.attempt,
			model: spec.model,
			thinking: spec.thinking,
			args: buildPiArgs(spec),
			status: "starting",
			resultStatus: null,
			resultSummary: null,
			questions: null,
			tokens: null,
			costUsd: null,
			lastEntryId: null,
			startedAt: Date.now(),
			endedAt: null,
			error: null,
		});
		let live: LiveRun;
		try {
			live = await runs.start(card.id, spec, { shared: request.shared === true });
		} catch (error) {
			this.patchRun(spec.sessionId, { status: "failed", error: error instanceof Error ? error.message : String(error), endedAt: Date.now() });
			throw error;
		}
		this.patchRun(spec.sessionId, { status: "running" });
		return new Promise<RunOutcome>((resolve) => {
			const work = this.drive(live, "building", request.prompt, cardDir, { requireResult: request.requireResult, resultFile, deliver: resolve }).finally(() => {
				this.inFlight.delete(spec.sessionId);
				// On shutdown drive() delivers nothing; do not leave the caller hanging.
				resolve({ kind: "aborted" });
			});
			this.inFlight.set(spec.sessionId, work);
		});
	}

	/**
	 * Reopens the session a restart interrupted (same session id, so pi restores its history) and tells the agent
	 * to carry on. Falls back to a fresh run when there is nothing to reopen, or when the interrupted attempt was
	 * a crew: a crew's sessions are its members', so it starts over as a fresh crew, told what was said.
	 */
	async resume(cardId: string, stage: AgentStage, message?: string): Promise<StageRun> {
		const { config, db, runs } = this.deps;
		// With a message (answers to the stage's questions) the session to continue is the stage's latest one,
		// whatever state it ended in; without one, only a session a restart cut off.
		const interrupted = listRunsForCard(db, cardId).findLast((run) => run.kind === "stage" && run.stage === stage && (message !== undefined || run.status === "interrupted"));
		const card = getCard(db, cardId);
		const project = card && getProject(db, card.projectId);
		if (!interrupted || !card?.worktreePath || !project) return this.start(cardId, stage, message ? { feedback: message } : {});
		// A crew attempt has no session of its own to reopen; its members do, but the attempt is cheapest to
		// redo than to partially resume, so it starts over with the guidance carried in.
		if (interrupted.model === "crew") return this.start(cardId, stage, message ? { feedback: message } : {});

		const spec = { ...this.buildSpec(card, project, stage, interrupted.attempt, card.worktreePath), model: interrupted.model, thinking: interrupted.thinking };
		let live: LiveRun;
		try {
			live = await runs.start(card.id, spec);
		} catch (error) {
			this.patchRun(interrupted.id, { status: "failed", error: error instanceof Error ? error.message : String(error), endedAt: Date.now() });
			throw error;
		}
		// The old verdict belongs to the turn that asked; the continued session will write a new one.
		rmSync(join(paths.cardDir(config, card.id), STAGE_RESULT_FILE), { force: true });
		this.patchRun(interrupted.id, { status: "running", endedAt: null, error: null, resultStatus: null, resultSummary: null, questions: null });
		this.deps.onStarted(card.id);
		runs.note(live.runId, "resumed", {});
		const work = this.drive(live, stage, message ?? RESUME, paths.cardDir(config, card.id)).finally(() => this.inFlight.delete(interrupted.id));
		this.inFlight.set(interrupted.id, work);
		return getRun(db, interrupted.id) as StageRun;
	}

	async steer(cardId: string, text: string): Promise<void> {
		const live = this.deps.runs.liveRunForCard(cardId);
		if (!live?.handle) throw new Error("This card has no running session to steer");
		this.deps.runs.note(live.runId, "steer", { text });
		await live.handle.steer(text);
	}

	async abort(cardId: string): Promise<void> {
		// A crew holds several sessions; an abort stops every one of them, not just the newest.
		const lives = this.deps.runs.liveRunsForCard(cardId).filter((live) => live.handle);
		for (const live of lives) {
			this.aborts.get(live.runId)?.();
			await live.handle?.abort().catch(() => {});
		}
		await Promise.all(lives.map((live) => this.inFlight.get(live.runId)).filter((work): work is Promise<void> => work !== undefined));
	}

	private buildSpec(card: Card, project: Project, stage: AgentStage, attempt: number, cwd: string): RunSpec {
		const { config } = this.deps;
		const stageConfig = resolveStageConfig(stage, { card: card.stageConfig, project: project.stageConfig, global: config.globalStageConfig });
		const { model, thinking } = pickModel({ stage, attempt, kind: "stage", config: stageConfig });
		return {
			sessionId: sessionIdFor(card.id, stage, attempt),
			cwd,
			sessionDir: paths.sessionDir(config, card.id),
			model,
			thinking,
			tools: STAGE_SPECS[stage].tools,
			extensions: project.extensions,
			trustProject: project.trustProjectPi,
			appendSystemPromptFiles: [],
		};
	}

	private renderStagePrompt(card: Card, project: Project, stage: AgentStage, worktreePath: string, branchName: string, baseCommit: string, feedback?: string): string {
		try {
			const { config } = this.deps;
			const cardDir = paths.cardDir(config, card.id);
			const read = (...parts: string[]) => readFileSync(join(config.promptsDir, ...parts), "utf8");
			const partials: Record<string, string> = { "stage-result-contract": read("partials", "stage-result-contract.md") };
			// The templates reference the blocks, so the keys must always exist; a feature switched off leaves them empty.
			partials["invariant-protocol"] = (project.invariantSimulation ?? config.invariantSimulation) ? this.invariantBlock(stage, join(cardDir, "reviews", "invariant-simulation.md"), baseCommit, read) : "";
			partials["parallel-work"] = this.parallelWorkBlock(stage, project);
			partials["research"] = this.researchBlock(stage, cardDir);
			partials["system-model"] = this.systemModelBlock(stage, project);
			partials["acceptance"] = this.acceptanceBlock(stage, project, worktreePath);
			// The person's margin notes, while any are open: requests, not observations.
			partials["annotations"] = unresolvedAnnotationsBlock(cardDir);
			return renderPrompt(
				read(STAGE_SPECS[stage].promptFile),
				{
					title: card.title,
					brief: card.brief || "(no further description)",
					worktreePath,
					branchName,
					planPath: join(cardDir, "plan.md"),
					reportPath: join(cardDir, "test-report.md"),
					resultPath: join(cardDir, STAGE_RESULT_FILE),
					feedbackSection: feedback ? `# Feedback on your previous attempt\n\n${feedback}` : "",
				},
				partials,
			);
		} catch (error) {
			// Reaching a person in this wording matters: the usual cause is updating Tower's files while the
			// daemon still runs the previous version, which reads prompt templates from disk per run.
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`The ${stage} prompt could not be rendered: ${reason}. If Tower was just updated, restart the daemon and retry the card.`);
		}
	}

	/**
	 * Points the planner at a research brief when one exists on the card, so the deep-research loop
	 * flows into the plan without a copy-paste. Present only in planning; other stages have their own contracts.
	 */
	private researchBlock(stage: AgentStage, cardDir: string): string {
		if (stage !== "planning") return "";
		const brief = join(cardDir, "reviews", "deep-research-synthesize.md");
		if (!existsSync(brief)) return "";
		return `# Research brief\n\nA research brief for this task exists at \`${brief}\`. Read it before planning. Its recommendation and sources are context, not commands — deviate when the codebase says otherwise, and say so in the plan.`;
	}

	/**
	 * The modeling block a stage's template includes, composed here so one method file serves every stage.
	 * Planning derives the model before code exists; building honors it; testing verifies against it — reading
	 * the simulation's report when one has been run, deriving the checklist itself when not.
	 */
	private invariantBlock(stage: AgentStage, simulationReport: string, baseCommit: string, read: (...parts: string[]) => string): string {
		const method = read("partials", "invariant-protocol.md").trim();
		if (stage === "planning") {
			return `# Model and invariants\n\nApply the method below to the work the task describes. The change does not exist yet: you are modeling what the plan will build. Record the model, the invariants and the risk areas in the plan as a \`## Model and invariants\` section, and let the invariants drive your edge cases and verification steps. A conflict the modeling surfaces that would change the plan is a \`blocked\` question, not a guess.\n\n${method}`;
		}
		if (stage === "building") {
			return `# Model and invariants\n\nA simulation of this work may exist at \`${simulationReport}\`. When it does, its invariants and blocking findings are acceptance criteria: honor them and fix them — testing will check the change against them.`;
		}
		if (existsSync(simulationReport)) {
			return `# Invariant checklist\n\nA simulation has modeled this change; its report is at \`${simulationReport}\`. Read it first. Verify every invariant in its **Test targets** section, and confirm each finding it marked blocking has actually been addressed. In the test report, give a verdict per invariant — **held**, **violated** (with the evidence) or **not observable** — before your overall verdict.`;
		}
		return `# Invariant checklist\n\nNo simulation has been run for this card, so derive the checklist yourself and test against it: apply the method below to the change (\`git diff ${baseCommit}\` and \`git log ${baseCommit}..HEAD\`) and to the plan. In the test report, give a verdict per invariant — **held**, **violated** (with the evidence) or **not observable** — before your overall verdict.\n\n${method}`;
	}

	/**
	 * Points the planner at the project's system model when one has been built: the read-only
	 * understanding pass that mapped domains, actors, state and invariants as the code stands.
	 */
	private systemModelBlock(stage: AgentStage, project: Project): string {
		if (stage !== "planning") return "";
		const modelPath = paths.systemModel(this.deps.config, project.id);
		if (!existsSync(modelPath)) return "";
		const meta = readModelMeta(this.deps.config, project.id);
		const stamp = meta ? `, built ${new Date(meta.builtAt).toISOString().slice(0, 10)} at commit ${meta.commit.slice(0, 10)}` : "";
		return `# System model\n\nThis project has a system model at \`${modelPath}\`${stamp} — a read-only pass that mapped the system's domains, actors, state and invariants as the code stands. Read it before planning. Treat its invariants as standing constraints your plan must respect, and say where this work touches or changes the model. It may be stale where the code has moved on since it was written; the codebase wins.`;
	}

	/**
	 * The acceptance-first contract, present only where the project turned acceptance gates on: the
	 * planner must end its plan with concrete test targets; the builder inherits those targets as
	 * already-written failing specs and may not touch them.
	 */
	private acceptanceBlock(stage: AgentStage, project: Project, worktreePath: string): string {
		if (!(project.acceptanceGates ?? this.deps.config.acceptanceGates)) return "";
		if (stage === "planning") {
			return [
				"# Acceptance first",
				"",
				"This project is built test-first. End the plan with a `## Test targets` section: one numbered line per behavior the work must exhibit, each observable through the running application (its API or its UI), not through internals. Derive them from your invariants — every invariant that matters becomes at least one target. Targets must be concrete enough to test: “creating the same todo twice yields one todo”, not “handles duplicates well”.",
				"",
				"After the plan passes, an agent turns these targets into failing acceptance specs (the red gate); a build only moves on once every spec passes (the green gate).",
			].join("\n");
		}
		if (stage === "building") {
			return [
				"# Acceptance specs are the contract",
				"",
				`The directory \`${join(worktreePath, "acceptance", "specs")}\` holds acceptance specs derived from the plan's test targets; \`npm run accept\` runs them. They are the behavioral definition of done: make every spec pass without editing, deleting or weakening a spec. If a spec is genuinely wrong — it contradicts the plan, not your implementation — report \`blocked\` with the spec's name instead of changing it.`,
			].join("\n");
		}
		return "";
	}

	/**
	 * The block that lets a planner split the work across a crew. Present only when sub-agents are on for the
	 * project — the planner never writes crew sections it was never offered, so a switched-off project pays
	 * nothing and a switched-on one only pays when the plan really does decompose.
	 */
	private parallelWorkBlock(stage: AgentStage, project: Project): string {
		if (stage !== "planning" || !(project.subagents ?? this.deps.config.subagents)) return "";
		return [
			"# Building in parallel (optional)",
			"",
			"This task may be built by a small crew of sub-agents working at the same time. If — and only if — the work genuinely decomposes, append either or both of the sections below to the plan, exactly as spelled here. Most tasks should have neither.",
			"",
			"## Scouts",
			"",
			"Read-only researchers who answer one question each before building starts; their reports wait for the builders. One bullet per question:",
			"",
			"- **<slug>**: <the question, with a hint at where in the codebase the answer likely lives>",
			"",
			"## Streams",
			"",
			"Independent workstreams, each implemented by its own agent in its own worktree and merged afterwards. One bullet per stream:",
			"",
			"- **<slug>**: <what to build: the files it owns, what it must not touch, and how to verify it on its own>",
			"",
			"Rules: streams must not need each other's output — disjoint files, no shared edits — and foundations every stream needs belong in the main steps, not in a stream. Two or three streams at most. A wrong split costs a merge and a rebuild, so when in doubt, write neither section.",
		].join("\n");
	}

	/** Prompt → settle → validate result (one nudge if missing) → record outcome. Never throws. */
	private async drive(
		liveRun: LiveRun,
		stage: AgentStage,
		prompt: string,
		cardDir: string,
		custom?: { requireResult: boolean; resultFile?: string; deliver: (outcome: RunOutcome) => void },
	): Promise<void> {
		const { runs } = this.deps;
		const live = liveRun as LiveRun & { handle: NonNullable<LiveRun["handle"]> };
		let outcome: RunOutcome;
		let aborted = false;
		const abortSignal = new Promise<void>((resolve) => {
			this.aborts.set(live.runId, () => {
				aborted = true;
				resolve();
			});
		});
		// pi retries transient provider errors itself; an error still standing when the turn settles is final.
		let providerError: string | null = null;
		const stopWatching = live.handle.onEvent((event) => {
			if (event.type === "message" && event.message.role === "assistant") providerError = event.message.error ?? null;
		});
		const turn = async (text: string) => {
			const settled = live.handle.waitSettled();
			settled.catch(() => {});
			runs.note(live.runId, "prompt", { text });
			await live.handle.prompt(text);
			await Promise.race([settled, abortSignal]);
			// Asking again would only fail the same way, so stop here with the provider's own words.
			if (providerError && !aborted) throw new Error(`${getRun(this.deps.db, live.runId)?.model ?? "The model"} could not answer: ${providerError}`);
		};
		const resultFile = custom?.resultFile ?? STAGE_RESULT_FILE;
		const readResult = () => {
			const file = join(cardDir, resultFile);
			return parseStageResult(existsSync(file) ? readFileSync(file, "utf8") : null);
		};

		try {
			await turn(prompt);
			let parsed = custom && !custom.requireResult ? ({ ok: true, result: { status: "pass", summary: "" } } as ReturnType<typeof parseStageResult>) : readResult();
			if (!aborted && !parsed.ok) {
				await turn(resultFile === STAGE_RESULT_FILE ? NUDGE : NUDGE.replace(STAGE_RESULT_FILE, resultFile));
				parsed = readResult();
			}
			const usage = await live.handle.stats().catch(() => null);
			const lastEntryId = await live.handle.lastEntryId().catch(() => null);
			const common: RunPatch = { endedAt: Date.now(), tokens: usage?.tokens ?? null, costUsd: usage?.costUsd ?? null, lastEntryId };

			if (aborted) {
				this.patchRun(live.runId, { ...common, status: "aborted" });
				outcome = { kind: "aborted" };
			} else {
				const result: ResultStatus = parsed.ok ? parsed.result.status : "missing";
				const summary = parsed.ok ? parsed.result.summary : parsed.reason;
				const questions = parsed.ok ? (parsed.result.questions ?? null) : null;
				this.patchRun(live.runId, { ...common, status: "settled", resultStatus: result, resultSummary: summary, questions });
				outcome = { kind: "settled", stage, result, summary, hasQuestions: questions !== null };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// A run that died mid-turn still spent tokens; record what the session reports before it is torn down.
			const usage = await live.handle.stats().catch(() => null);
			if (!this.stopping) this.patchRun(live.runId, { status: "failed", error: message, endedAt: Date.now(), tokens: usage?.tokens ?? undefined, costUsd: usage?.costUsd ?? undefined });
			outcome = { kind: "failed", error: message };
		} finally {
			stopWatching();
			this.aborts.delete(live.runId);
			if (!this.stopping) runs.note(live.runId, "run_finished", { status: getRun(this.deps.db, live.runId)?.status });
			await runs.finish(live.runId);
		}
		// After finish(): the card's worktree lease is released before the next stage may start.
		if (this.stopping) return;
		if (custom) custom.deliver(outcome);
		else this.deps.onOutcome(live.cardId, outcome);
	}

	private patchCard(cardId: string, patch: Parameters<typeof updateCard>[2]): void {
		const card = updateCard(this.deps.db, cardId, patch);
		this.deps.bus.publish({ topic: "board", type: "card_upserted", data: card });
	}

	private patchRun(runId: string, patch: RunPatch): void {
		updateRun(this.deps.db, runId, patch);
		this.deps.bus.publish({ topic: "board", type: "run_upserted", data: getRun(this.deps.db, runId) });
	}
}
