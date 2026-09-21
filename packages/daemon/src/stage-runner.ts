import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentStage,
	type Card,
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
import type { Db } from "./db/open.ts";
import { getCard, updateCard } from "./db/repo-cards.ts";
import { getProject } from "./db/repo-projects.ts";
import { countRunsForStage, getRun, insertRun, listRunsForCard, type RunPatch, updateRun } from "./db/repo-runs.ts";
import type { Bus } from "./events/bus.ts";
import { runSetup } from "./git/setup.ts";
import { branchNameFor, ensureWorktree } from "./git/worktree-manager.ts";
import { buildPiArgs } from "./pi/argv.ts";
import type { LiveRun, RunManager } from "./run/run-manager.ts";

const RESUME = `You were interrupted by a restart of the orchestrator; nothing else changed. Check the state of your work, then continue the task from where you left off. Your original instructions still apply, including writing ${STAGE_RESULT_FILE} when you are done.`;

const NUDGE = `You stopped without writing the required result file. Write ${STAGE_RESULT_FILE} now, exactly as specified in your instructions, then stop.`;

/** How a stage run ended. The orchestrator turns this into a card transition. */
export type RunOutcome =
	| { kind: "settled"; stage: AgentStage; result: ResultStatus; summary: string; hasQuestions: boolean }
	| { kind: "failed"; error: string }
	| { kind: "aborted" };

/** A session that is not a card stage: a review-flow step or an ad hoc run. */
export interface CustomRun {
	sessionId: string;
	kind: "flow_step" | "adhoc";
	attempt: number;
	model: string;
	thinking: ThinkingLevel;
	tools: string[];
	prompt: string;
	appendSystemPromptFiles?: string[];
	/** Whether the session must end by writing stage-result.json. */
	requireResult: boolean;
}

export interface StageRunnerDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
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

		const worktree = await ensureWorktree({
			repoPath: project.repoPath,
			path: card.worktreePath ?? paths.worktree(config, project.id, card.id),
			branchName: card.branchName ?? branchNameFor(card.id, card.title),
			baseBranch: project.defaultBranch,
		});
		// A fresh worktree has no node_modules, venv or build cache; the project says how to make it usable.
		if (worktree.created && project.setupCommand) await runSetup(project.setupCommand, worktree.path);
		const cardDir = paths.cardDir(config, card.id);
		mkdirSync(paths.sessionDir(config, card.id), { recursive: true });
		// A stale result from an earlier stage must never be read as this stage's verdict.
		rmSync(join(cardDir, STAGE_RESULT_FILE), { force: true });

		const attempt = countRunsForStage(db, card.id, stage) + 1;
		const spec = this.buildSpec(card, project, stage, attempt, worktree.path);
		// A build that repairs a failing pull request is told apart from ordinary builds by its session id.
		if (options.fixingCi) spec.sessionId = `c${card.id}-cifix-${attempt}`;
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

		const feedback = options.fixingCi && options.feedback ? `This work is already in a pull request, and its CI checks are failing. Fix the cause, commit, and do not weaken the checks.\n\n${options.feedback}` : options.feedback;
		const prompt = this.renderStagePrompt(card, stage, worktree.path, worktree.branchName, feedback);
		const work = this.drive(live, stage, prompt, cardDir).finally(() => this.inFlight.delete(run.id));
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
		if (!card.worktreePath) throw new Error("This card has no worktree yet. Start it first.");
		const cardDir = paths.cardDir(config, card.id);
		mkdirSync(join(cardDir, "reviews"), { recursive: true });
		if (request.requireResult) rmSync(join(cardDir, STAGE_RESULT_FILE), { force: true });

		const spec: RunSpec = {
			sessionId: request.sessionId,
			cwd: card.worktreePath,
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
			live = await runs.start(card.id, spec);
		} catch (error) {
			this.patchRun(spec.sessionId, { status: "failed", error: error instanceof Error ? error.message : String(error), endedAt: Date.now() });
			throw error;
		}
		this.patchRun(spec.sessionId, { status: "running" });
		return new Promise<RunOutcome>((resolve) => {
			const work = this.drive(live, "building", request.prompt, cardDir, { requireResult: request.requireResult, deliver: resolve }).finally(() => {
				this.inFlight.delete(spec.sessionId);
				// On shutdown drive() delivers nothing; do not leave the caller hanging.
				resolve({ kind: "aborted" });
			});
			this.inFlight.set(spec.sessionId, work);
		});
	}

	/**
	 * Reopens the session a restart interrupted (same session id, so pi restores its history) and tells the agent
	 * to carry on. Falls back to a fresh run when there is nothing to reopen.
	 */
	async resume(cardId: string, stage: AgentStage, message?: string): Promise<StageRun> {
		const { config, db, runs } = this.deps;
		// With a message (answers to the stage's questions) the session to continue is the stage's latest one,
		// whatever state it ended in; without one, only a session a restart cut off.
		const interrupted = listRunsForCard(db, cardId).findLast((run) => run.kind === "stage" && run.stage === stage && (message !== undefined || run.status === "interrupted"));
		const card = getCard(db, cardId);
		const project = card && getProject(db, card.projectId);
		if (!interrupted || !card?.worktreePath || !project) return this.start(cardId, stage);

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
		const live = this.deps.runs.liveRunForCard(cardId);
		if (!live?.handle) throw new Error("This card has no running session to abort");
		this.aborts.get(live.runId)?.();
		await live.handle.abort().catch(() => {});
		await this.inFlight.get(live.runId);
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

	private renderStagePrompt(card: Card, stage: AgentStage, worktreePath: string, branchName: string, feedback?: string): string {
		const { config } = this.deps;
		const cardDir = paths.cardDir(config, card.id);
		const read = (...parts: string[]) => readFileSync(join(config.promptsDir, ...parts), "utf8");
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
			{ "stage-result-contract": read("partials", "stage-result-contract.md") },
		);
	}

	/** Prompt → settle → validate result (one nudge if missing) → record outcome. Never throws. */
	private async drive(
		liveRun: LiveRun,
		stage: AgentStage,
		prompt: string,
		cardDir: string,
		custom?: { requireResult: boolean; deliver: (outcome: RunOutcome) => void },
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
		const readResult = () => {
			const file = join(cardDir, STAGE_RESULT_FILE);
			return parseStageResult(existsSync(file) ? readFileSync(file, "utf8") : null);
		};

		try {
			await turn(prompt);
			let parsed = custom && !custom.requireResult ? ({ ok: true, result: { status: "pass", summary: "" } } as ReturnType<typeof parseStageResult>) : readResult();
			if (!aborted && !parsed.ok) {
				await turn(NUDGE);
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
			if (!this.stopping) this.patchRun(live.runId, { status: "failed", error: message, endedAt: Date.now() });
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
