import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Card,
	type CardEvent,
	decideAfterFailure,
	type Effect,
	eligible,
	type FailureDecision,
	type GateKind,
	pickNext,
	type ReadyCard,
	requiredGates,
	type SchedulerState,
	type StageRun,
	transition,
} from "@tower/core";
import { type Config, paths } from "./config.ts";
import type { Db } from "./db/open.ts";
import { getCard, listExecuting, listQueued, setQueuedEffect, updateCard } from "./db/repo-cards.ts";
import { decideGate, getGate, insertGate } from "./db/repo-gates.ts";
import { getProject, listProjects } from "./db/repo-projects.ts";
import { countRunsForStage, getRun, insertRun, interruptActiveRuns, lastRunForCard, updateRun } from "./db/repo-runs.ts";
import type { Bus } from "./events/bus.ts";
import type { RunManager } from "./run/run-manager.ts";
import type { RunOutcome, StageRunner } from "./stage-runner.ts";
import { runVerify } from "./verifier.ts";

export interface OrchestratorDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
	stages: StageRunner;
}

/** The request is well-formed but conflicts with the card's current state. */
export class ConflictError extends Error {}

const verifyOutputFile = (attempt: number) => `verify-output-${attempt}.txt`;

/** The only caller of core.transition() and the only executor of its effects. */
export class Orchestrator {
	private readonly deps: OrchestratorDeps;
	private readonly pending = new Set<Promise<void>>();
	private readonly verifyAborts = new Map<string, () => void>();
	/** Cards taken off the queue whose work has not reported "running" yet; they already occupy a slot. */
	private readonly launching = new Map<string, string>();
	private stopping = false;

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
	}

	/** Applies an event to a card: persist the next state, publish it, then carry out the effects. Throws InvalidTransition. */
	dispatch(cardId: string, event: CardEvent): Card {
		const { db, bus } = this.deps;
		const card = getCard(db, cardId);
		if (!card) throw new Error(`Card not found: ${cardId}`);
		const { next, effects } = transition(card, event);
		const updated = updateCard(db, cardId, next);
		bus.publish({ topic: "board", type: "card_upserted", data: updated });
		for (const effect of effects) this.execute(cardId, effect);
		// Any transition can free a slot or add work, so let the scheduler look again.
		this.schedule();
		return updated;
	}

	resume(cardId: string): Card {
		return this.dispatch(cardId, { type: "resume", wasVerifying: lastRunForCard(this.deps.db, cardId)?.kind === "verify" });
	}

	/** Boot-time recovery: whatever the previous process left in flight is now interrupted; the queue simply continues. */
	recover(): void {
		const { db } = this.deps;
		const executing = listExecuting(db);
		interruptActiveRuns(db);
		for (const card of executing) this.dispatch(card.id, { type: "daemon_restarted" });
		this.schedule();
	}

	retry(cardId: string, feedback?: string): Card {
		return this.dispatch(cardId, { type: "retry", ...(feedback ? { feedback } : {}), hasVerifyCommand: this.verifyCommandFor(cardId) !== null });
	}

	/** Stops whatever is running for the card: an agent session or the verify command. */
	async abort(cardId: string): Promise<void> {
		const stopVerify = this.verifyAborts.get(cardId);
		if (listQueued(this.deps.db).some((queued) => queued.card.id === cardId)) {
			// Still waiting for a slot: take it off the queue.
			setQueuedEffect(this.deps.db, cardId, null);
			this.dispatch(cardId, { type: "run_aborted" });
		} else if (stopVerify) stopVerify();
		else await this.deps.stages.abort(cardId);
		await this.settled(cardId);
	}

	/** Stops starting work and kills verify commands without recording how they ended, so the next boot can recover them. */
	beginShutdown(): void {
		this.stopping = true;
		this.deps.stages.beginShutdown();
		for (const stop of this.verifyAborts.values()) stop();
	}

	/** True while the card is queued, launching or executing. */
	isBusy(cardId: string): boolean {
		return this.launching.has(cardId) || this.deps.runs.liveRunForCard(cardId) !== null || listQueued(this.deps.db).some((queued) => queued.card.id === cardId);
	}

	private async settled(cardId: string): Promise<void> {
		while (this.launching.has(cardId) || this.deps.runs.liveRunForCard(cardId)) await new Promise((resolve) => setTimeout(resolve, 10));
	}

	decideGate(cardId: string, gateId: string, decision: "approve" | "reject", feedback: string): Card {
		const gate = getGate(this.deps.db, gateId);
		if (!gate || gate.cardId !== cardId) throw new Error(`Gate not found: ${gateId}`);
		if (gate.status !== "pending") throw new ConflictError("This gate has already been decided");
		// Transition first: if it is invalid nothing is recorded.
		const card = this.dispatch(cardId, { type: "gate_decided", decision, feedback });
		decideGate(this.deps.db, gateId, decision === "approve" ? "approved" : "rejected", feedback || null);
		this.deps.bus.publish({ topic: "board", type: "gate_decided", data: { cardId, gateId, decision } });
		return card;
	}

	handleStarted(cardId: string): void {
		// From here the card's "running" status holds its slot.
		this.launching.delete(cardId);
		this.dispatch(cardId, { type: "run_started" });
	}

	handleOutcome(cardId: string, outcome: RunOutcome): void {
		if (outcome.kind === "failed") this.dispatch(cardId, { type: "run_failed", error: outcome.error });
		else if (outcome.kind === "aborted") this.dispatch(cardId, { type: "run_aborted" });
		else {
			this.dispatch(cardId, {
				type: "run_settled",
				result: outcome.result,
				summary: outcome.summary,
				// Gathered here, with IO, so that transition() can stay pure.
				context: {
					requiredGates: outcome.stage === "planning" && outcome.result === "pass" ? this.gatesFor(cardId) : [],
					hasVerifyCommand: this.verifyCommandFor(cardId) !== null,
					onFailure: this.failureDecision(cardId, outcome.summary, null),
				},
			});
		}
	}

	/** Resolves when no effect is being carried out and no stage is running. For tests and shutdown. */
	async whenIdle(): Promise<void> {
		const { stages } = this.deps;
		while (this.pending.size > 0 || stages.inFlight.size > 0) {
			await Promise.allSettled([...this.pending, ...stages.inFlight.values()]);
		}
	}

	private verifyCommandFor(cardId: string): string | null {
		const card = getCard(this.deps.db, cardId);
		return (card && getProject(this.deps.db, card.projectId)?.verifyCommand) || null;
	}

	private gatesFor(cardId: string): GateKind[] {
		const card = getCard(this.deps.db, cardId) as Card;
		const planFile = join(paths.cardDir(this.deps.config, cardId), "plan.md");
		const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : "";
		return requiredGates({
			card: { title: card.title, brief: card.brief, planningAttempt: card.attempt },
			plan: { bytes: Buffer.byteLength(plan), lines: plan.split("\n").length },
		});
	}

	private failureDecision(cardId: string, output: string, previousOutput: string | null): FailureDecision {
		return decideAfterFailure({
			buildAttempt: countRunsForStage(this.deps.db, cardId, "building"),
			maxBuildAttempts: this.deps.config.maxBuildAttempts,
			output,
			previousOutput,
		});
	}

	private execute(cardId: string, effect: Effect): void {
		if (effect.type === "open_gate") {
			const gate = { id: randomUUID().slice(0, 8), cardId, kind: effect.kind, createdAt: Date.now() };
			insertGate(this.deps.db, gate);
			this.deps.bus.publish({ topic: "board", type: "gate_opened", data: gate });
			return;
		}
		// Work is queued, not started: the scheduler decides when it gets a slot.
		setQueuedEffect(this.deps.db, cardId, effect);
	}

	/** Starts queued work while the caps allow it. Which eligible card goes next is the pickNext policy's call. */
	private schedule(): void {
		const { db, config } = this.deps;
		if (this.stopping) return;
		for (;;) {
			const queued = listQueued(db);
			if (queued.length === 0) return;
			const executing = listExecuting(db).filter((card) => !this.launching.has(card.id));
			const state: SchedulerState = {
				ready: queued.map(({ card, queuedAt }): ReadyCard => ({
					cardId: card.id,
					projectId: card.projectId,
					stage: card.stage,
					priority: card.priority,
					queuedAt,
					buildAttempt: countRunsForStage(db, card.id, "building"),
				})),
				running: [...executing.map((card) => ({ cardId: card.id, projectId: card.projectId })), ...[...this.launching].map(([cardId, projectId]) => ({ cardId, projectId }))],
				caps: { global: config.maxConcurrent, perProject: Object.fromEntries(listProjects(db).map((project) => [project.id, project.concurrencyLimit])) },
			};
			const candidates = eligible(state);
			const pickedId = pickNext(candidates, state);
			// The policy chooses among candidates; it cannot start something the caps do not allow.
			const picked = queued.find((entry) => entry.card.id === pickedId && candidates.some((candidate) => candidate.cardId === pickedId));
			if (!picked) return;
			this.launch(picked.card, picked.effect);
		}
	}

	private launch(card: Card, effect: Effect): void {
		if (effect.type === "open_gate") return;
		const { stages } = this.deps;
		setQueuedEffect(this.deps.db, card.id, null);
		this.launching.set(card.id, card.projectId);
		const started =
			effect.type === "run_verify"
				? this.verify(card.id)
				: (effect.type === "resume_run" ? stages.resume(card.id, effect.stage) : stages.start(card.id, effect.stage, effect.feedback ? { feedback: effect.feedback } : {})).then(() => {});
		const work = started
			.catch((error) => {
				if (!this.stopping) this.dispatch(card.id, { type: "run_failed", error: error instanceof Error ? error.message : String(error) });
			})
			.finally(() => {
				this.pending.delete(work);
				this.launching.delete(card.id);
				this.schedule();
			});
		this.pending.add(work);
	}

	/** Runs the project's verify command as a transcripted run and feeds the verdict back into the lifecycle. */
	private async verify(cardId: string): Promise<void> {
		const { config, db, bus, runs } = this.deps;
		const card = getCard(db, cardId) as Card;
		const command = this.verifyCommandFor(cardId);
		if (!command || !card.worktreePath) throw new Error("This card has no verify command or worktree");

		const attempt = countRunsForStage(db, cardId, "testing") + 1;
		const run: StageRun = {
			id: `c${cardId}-verify-${attempt}`,
			cardId,
			kind: "verify",
			stage: "testing",
			attempt,
			model: command,
			thinking: "off",
			args: [],
			status: "running",
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
		const publishRun = () => bus.publish({ topic: "board", type: "run_upserted", data: getRun(db, run.id) });
		publishRun();

		const live = runs.openLog(cardId, run.id);
		try {
			const { done, abort } = runVerify({ command, cwd: card.worktreePath, timeoutMs: config.verifyTimeoutMs, buffer: live.buffer });
			this.verifyAborts.set(cardId, abort);
			const result = await done;
			if (this.stopping) {
				await runs.finish(run.id);
				return;
			}

			const cardDir = paths.cardDir(config, cardId);
			mkdirSync(cardDir, { recursive: true });
			writeFileSync(join(cardDir, verifyOutputFile(attempt)), result.output);
			const summary = result.aborted ? "Aborted." : result.passed ? "Verify command passed." : `Verify command exited with code ${result.exitCode}.`;
			updateRun(db, run.id, { status: result.aborted ? "aborted" : "settled", resultStatus: result.aborted ? null : result.passed ? "pass" : "fail", resultSummary: summary, endedAt: Date.now() });
			runs.note(run.id, "run_finished", { status: summary });
			await runs.finish(run.id);
			publishRun();

			if (result.aborted) {
				this.dispatch(cardId, { type: "run_aborted" });
				return;
			}
			const previousFile = join(cardDir, verifyOutputFile(attempt - 1));
			const previous = existsSync(previousFile) ? readFileSync(previousFile, "utf8") : null;
			this.dispatch(cardId, { type: "verify_finished", passed: result.passed, onFailure: this.failureDecision(cardId, result.output, previous) });
		} catch (error) {
			updateRun(db, run.id, { status: "failed", error: error instanceof Error ? error.message : String(error), endedAt: Date.now() });
			await runs.finish(run.id);
			publishRun();
			throw error;
		} finally {
			this.verifyAborts.delete(cardId);
		}
	}
}
