import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentStage,
	type Card,
	type Project,
	type RunSpec,
	type StageRun,
	parseStageResult,
	pickModel,
	renderPrompt,
	resolveStageConfig,
	sessionIdFor,
	STAGE_RESULT_FILE,
	STAGE_SPECS,
} from "@traffic-control/core";
import { type Config, paths } from "./config.ts";
import type { Db } from "./db/open.ts";
import { getCard, updateCard } from "./db/repo-cards.ts";
import { getProject } from "./db/repo-projects.ts";
import { countRunsForStage, getRun, insertRun, type RunPatch, updateRun } from "./db/repo-runs.ts";
import type { Bus } from "./events/bus.ts";
import { branchNameFor, ensureWorktree } from "./git/worktree-manager.ts";
import { buildPiArgs } from "./pi/argv.ts";
import type { LiveRun, RunManager } from "./run/run-manager.ts";

const NUDGE = `You stopped without writing the required result file. Write ${STAGE_RESULT_FILE} now, exactly as specified in your instructions, then stop.`;

export interface StageRunnerDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
}

/** Executes one agent stage for a card: worktree, prompt, session, result validation, bookkeeping. */
export class StageRunner {
	private readonly deps: StageRunnerDeps;
	private readonly aborts = new Map<string, () => void>();
	/** Settles when the background work of a run is finished. Tests and shutdown await these. */
	readonly inFlight = new Map<string, Promise<void>>();

	constructor(deps: StageRunnerDeps) {
		this.deps = deps;
	}

	/** Starts the stage and returns once the session is up. The stage itself continues in the background. */
	async start(cardId: string, stage: AgentStage, options: { feedback?: string } = {}): Promise<StageRun> {
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
		const cardDir = paths.cardDir(config, card.id);
		mkdirSync(paths.sessionDir(config, card.id), { recursive: true });
		// A stale result from an earlier stage must never be read as this stage's verdict.
		rmSync(join(cardDir, STAGE_RESULT_FILE), { force: true });

		const attempt = countRunsForStage(db, card.id, stage) + 1;
		const spec = this.buildSpec(card, project, stage, attempt, worktree.path);
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
			tokens: null,
			costUsd: null,
			lastEntryId: null,
			startedAt: Date.now(),
			endedAt: null,
			error: null,
		};
		insertRun(db, run);
		this.patchCard(card.id, {
			stage,
			status: "running",
			attempt,
			worktreePath: worktree.path,
			branchName: worktree.branchName,
			baseCommit: worktree.baseCommit,
			needsAttentionReason: null,
		});

		let live: LiveRun;
		try {
			live = await runs.start(card.id, spec);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.patchRun(run.id, { status: "failed", error: message, endedAt: Date.now() });
			this.patchCard(card.id, { status: "needs_attention", needsAttentionReason: message });
			throw error;
		}
		this.patchRun(run.id, { status: "running" });

		const prompt = this.renderStagePrompt(card, stage, worktree.path, worktree.branchName, options.feedback);
		const work = this.drive(live, prompt, cardDir).finally(() => this.inFlight.delete(run.id));
		this.inFlight.set(run.id, work);
		return getRun(db, run.id) as StageRun;
	}

	async steer(cardId: string, text: string): Promise<void> {
		const live = this.deps.runs.liveRunForCard(cardId);
		if (!live) throw new Error("This card has no running session to steer");
		this.deps.runs.note(live.runId, "steer", { text });
		await live.handle.steer(text);
	}

	async abort(cardId: string): Promise<void> {
		const live = this.deps.runs.liveRunForCard(cardId);
		if (!live) throw new Error("This card has no running session to abort");
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
				resultPath: join(cardDir, STAGE_RESULT_FILE),
				feedbackSection: feedback ? `# Feedback on your previous attempt\n\n${feedback}` : "",
			},
			{ "stage-result-contract": read("partials", "stage-result-contract.md") },
		);
	}

	/** Prompt → settle → validate result (one nudge if missing) → record outcome. Never throws. */
	private async drive(live: LiveRun, prompt: string, cardDir: string): Promise<void> {
		const { runs } = this.deps;
		let aborted = false;
		const abortSignal = new Promise<void>((resolve) => {
			this.aborts.set(live.runId, () => {
				aborted = true;
				resolve();
			});
		});
		const turn = async (text: string) => {
			const settled = live.handle.waitSettled();
			settled.catch(() => {});
			runs.note(live.runId, "prompt", { text });
			await live.handle.prompt(text);
			await Promise.race([settled, abortSignal]);
		};
		const readResult = () => {
			const file = join(cardDir, STAGE_RESULT_FILE);
			return parseStageResult(existsSync(file) ? readFileSync(file, "utf8") : null);
		};

		try {
			await turn(prompt);
			let parsed = readResult();
			if (!aborted && !parsed.ok) {
				await turn(NUDGE);
				parsed = readResult();
			}
			const usage = await live.handle.stats().catch(() => null);
			const lastEntryId = await live.handle.lastEntryId().catch(() => null);
			const common: RunPatch = { endedAt: Date.now(), tokens: usage?.tokens ?? null, costUsd: usage?.costUsd ?? null, lastEntryId };

			if (aborted) {
				this.patchRun(live.runId, { ...common, status: "aborted" });
				this.patchCard(live.cardId, { status: "idle" });
			} else if (!parsed.ok) {
				this.patchRun(live.runId, { ...common, status: "settled", resultStatus: "missing", resultSummary: parsed.reason });
				this.patchCard(live.cardId, { status: "needs_attention", needsAttentionReason: parsed.reason });
			} else {
				const { status, summary } = parsed.result;
				this.patchRun(live.runId, { ...common, status: "settled", resultStatus: status, resultSummary: summary });
				// M1 has no state machine yet: a passing stage simply rests. M2 replaces this with core.transition().
				this.patchCard(
					live.cardId,
					status === "pass" ? { status: "idle" } : { status: "needs_attention", needsAttentionReason: `${status}: ${summary}` },
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.patchRun(live.runId, { status: "failed", error: message, endedAt: Date.now() });
			this.patchCard(live.cardId, { status: "needs_attention", needsAttentionReason: message });
		} finally {
			this.aborts.delete(live.runId);
			runs.note(live.runId, "run_finished", { status: getRun(this.deps.db, live.runId)?.status });
			await runs.finish(live.runId);
		}
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
