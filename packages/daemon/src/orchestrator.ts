import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Card,
	type CardEvent,
	decideAfterFailure,
	type Effect,
	eligible,
	type FailureDecision,
	type GateKind,
	pickNext,
	type Project,
	type ReadyCard,
	requiredGates,
	type SchedulerState,
	STAGE_RESULT_FILE,
	type StageRun,
	transition,
} from "@tower/core";
import { type Config, paths } from "./config.ts";
import type { Db } from "./db/open.ts";
import { getCard, getCardByIssue, insertCard, listCards, listExecuting, listLandedIds, listQueued, listWatchedPullRequests, setQueuedEffect, updateCard, type CardPatch } from "./db/repo-cards.ts";
import { decideGate, getGate, insertGate, listGatesForCard } from "./db/repo-gates.ts";
import { getProject, listProjects } from "./db/repo-projects.ts";
import { countRunsForStage, getRun, insertRun, interruptActiveRuns, lastRunForCard, listRunsForCard, updateRun } from "./db/repo-runs.ts";
import type { Bus } from "./events/bus.ts";
import { issueBrief } from "./feedback.ts";
import { flowsTriggered, type Flow, type FlowTrigger, loadFlows, runsOnBacklogCard } from "./flows.ts";
import type { AdhocRequest, FlowRunner } from "./flow-runner.ts";
import { removeWorktree, streamWorktreePaths } from "./git/worktree-manager.ts";
import { deleteMergedBranch, mergeBranchLocally } from "./git/merge.ts";
import { type Issue, closeIssue, commentOnIssue, createPullRequest, listIssues, listRemotes, originSlug, pushBranch, viewPullRequest } from "./pr/gh.ts";
import { feedbackWithAnnotations } from "./annotations.ts";
import type { RunManager } from "./run/run-manager.ts";
import type { RunOutcome, StageRunner } from "./stage-runner.ts";
import { modelState, promoteSystemModel } from "./system-model.ts";
import { runVerify } from "./verifier.ts";

export interface OrchestratorDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
	stages: StageRunner;
	flows: FlowRunner;
}

/** The request is well-formed but conflicts with the card's current state. */
export class ConflictError extends Error {}

const verifyOutputFile = (attempt: number) => `verify-output-${attempt}.txt`;

/** The flow that builds a project's system model; the before-plan hook runs it by name, then promotes its report. */
const UNDERSTAND_FLOW = "understand-system";
/** The shipped acceptance gates: they run only where the project turned acceptance gates on. */
const ACCEPTANCE_FLOWS = new Set(["acceptance-red", "acceptance-green"]);

/** The only caller of core.transition() and the only executor of its effects. */
export class Orchestrator {
	private readonly deps: OrchestratorDeps;
	private readonly pending = new Set<Promise<void>>();
	private readonly verifyAborts = new Map<string, () => void>();
	/** Cards taken off the queue whose work has not reported "running" yet; they already occupy a slot. */
	private readonly launching = new Map<string, string>();
	private stopping = false;
	/** The head commit whose failing checks were already handed to a builder, per card, so one failure is fixed once. */
	private readonly handledCiFailures = new Map<string, string>();
	private prTimer: NodeJS.Timeout | null = null;
	private issueTimer: NodeJS.Timeout | null = null;
	private scheduleTimer: NodeJS.Timeout | null = null;
	/** Said once per process, not once per poll: the feedback repo has issues but no project tracks it. */
	private warnedNoIntakeProject = false;

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
	}

	/** Applies an event to a card: persist the next state, publish it, then carry out the effects. Throws InvalidTransition. */
	dispatch(cardId: string, event: CardEvent): Card {
		const { db, bus } = this.deps;
		const card = getCard(db, cardId);
		if (!card) throw new Error(`Card not found: ${cardId}`);
		const { next, effects } = transition(card, event);
		// A done card's parting words (merged locally, PR merged) are an outcome, not an attention
		// reason: they land in finish_note, and leaving done clears them.
		let patch: CardPatch = next;
		if (next.stage === "done") {
			patch = { ...next, finishNote: next.needsAttentionReason ?? card.finishNote, needsAttentionReason: null };
		} else if (card.finishNote !== null) {
			patch = { ...next, finishNote: null };
		}
		const updated = updateCard(db, cardId, patch);
		bus.publish({ topic: "board", type: "card_upserted", data: updated });
		for (const effect of effects) this.execute(cardId, effect);
		// Any transition can free a slot or add work, so let the scheduler look again.
		this.schedule();
		return updated;
	}

	resume(cardId: string): Card {
		return this.dispatch(cardId, { type: "resume", wasVerifying: lastRunForCard(this.deps.db, cardId)?.kind === "verify" });
	}

	/** The enqueue the board and the ask box use: it gathers whether the project wants its system model rebuilt before planning. */
	async enqueueCard(cardId: string): Promise<Card> {
		const understandFirst = await this.understandFirstFor(cardId);
		return this.dispatch(cardId, understandFirst ? { type: "enqueue", understandFirst: true } : { type: "enqueue" });
	}

	/** Runs the scheduler now. A card that left the board releases whatever waited on it, and that wait
	 *  ends outside any transition — so deletion, unlike a gate decision, must invite the queue itself. */
	reschedule(): void {
		this.schedule();
	}

	/** Whether enqueue should run the understanding pass first: the project opted in, and the model is missing or the code has moved past it. */
	private async understandFirstFor(cardId: string): Promise<boolean> {
		const card = getCard(this.deps.db, cardId);
		const project = card && getProject(this.deps.db, card.projectId);
		if (!project || !(project.understandBeforePlan ?? this.deps.config.understandBeforePlan)) return false;
		try {
			const { state } = await modelState(this.deps.config, project.id, project.repoPath, project.defaultBranch);
			return state !== "fresh";
		} catch {
			return false;
		}
	}

	/**
	 * Builds the project's system model on demand: an inert backlog card carries the understanding run
	 * (its transcript is the audit trail), and when the run passes, its report becomes the project's
	 * system model — the one every planner reads until the code moves past it.
	 */
	understandProject(projectId: string): Card {
		const project = getProject(this.deps.db, projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const title = `System model — ${project.name}`;
		if (listCards(this.deps.db).some((candidate) => candidate.projectId === projectId && candidate.title === title && this.isBusy(candidate.id))) {
			throw new ConflictError("An understanding run is already in flight for this project");
		}
		const card = this.fileCard(projectId, title, "Build the project's system model: domains, actors, state, invariants as built. This card carries the understanding run; the model it produces is saved on the project and read by every planner afterwards.");
		const work = this.deps.flows
			.runFlows(card.id, [UNDERSTAND_FLOW])
			.then(async (outcome) => {
				if (outcome.kind === "settled" && outcome.result === "pass") {
					try {
						await this.promoteUnderstanding(card.id);
					} catch (error) {
						console.error(`understanding ${project.name}: could not save the model —`, error instanceof Error ? error.message : error);
					}
				} else if (outcome.kind === "failed") {
					console.error(`understanding ${project.name}:`, outcome.error);
				} else if (outcome.kind === "settled") {
					console.error(`understanding ${project.name}: the run did not pass (${outcome.summary})`);
				}
				this.deps.bus.publish({ topic: "board", type: "card_upserted", data: getCard(this.deps.db, card.id) });
			})
			.catch((error) => console.error(`understanding ${project.name} failed:`, error instanceof Error ? error.message : error))
			.finally(() => this.pending.delete(work));
		this.pending.add(work);
		return card;
	}

	/** Files a card straight onto the backlog: inert until a person or a policy starts it. */
	private fileCard(projectId: string, title: string, brief: string): Card {
		const now = Date.now();
		const card: Card = {
			id: randomUUID().replaceAll("-", "").slice(0, 8),
			projectId,
			title,
			brief,
			stage: "backlog",
			status: "idle",
			priority: 0,
			position: now,
			branchName: null,
			worktreePath: null,
			baseCommit: null,
			attempt: 0,
			stageConfig: {},
			prUrl: null,
			prState: null,
			needsAttentionReason: null,
			finishNote: null,
			baseCardId: null,
			dependsOn: null,
			issueUrl: null,
			issueNumber: null,
			issueAuthor: null,
			createdAt: now,
			updatedAt: now,
		};
		insertCard(this.deps.db, card);
		this.deps.bus.publish({ topic: "board", type: "card_upserted", data: card });
		return card;
	}

	/** Boot-time recovery: whatever the previous process left in flight is now interrupted; the queue simply continues. */
	recover(): void {
		const { db } = this.deps;
		const executing = listExecuting(db);
		interruptActiveRuns(db);
		for (const card of executing) this.dispatch(card.id, { type: "daemon_restarted" });
		this.schedule();
	}

	/** Hands a person's answers to the stage that asked, continuing its session so nothing it learned is lost.
	 *  When the asker was a hook-flow step (the card is stuck at needs_attention, not awaiting input), the
	 *  answers become the rerun's feedback: the same decision, delivered through the one door that is open. */
	answer(cardId: string, answers: Array<{ question: string; answer: string }>): Card {
		const lines = answers.map(({ question, answer }, index) => `${index + 1}. ${question}\n   Answer: ${answer}`);
		const message = [
			"Here are the answers to your questions:",
			"",
			...lines,
			"",
			`Treat them as decisions and continue the task from where you stopped. Your original instructions still apply, including writing ${STAGE_RESULT_FILE} when you are done. Ask again only if something new and essential is still open.`,
		].join("\n");
		const card = getCard(this.deps.db, cardId);
		if (card?.status === "needs_attention") {
			const last = listRunsForCard(this.deps.db, cardId).findLast((run) => run.status === "settled" && run.questions !== null);
			if (last?.kind === "flow_step" && (last.stage === "planning" || last.stage === "testing")) {
				const feedback = `You stopped to ask; the person has decided. ${message}`;
				const gate = last.id.includes(UNDERSTAND_FLOW)
					? { beforePlan: true }
					: last.stage === "testing"
						? { gateFeedback: feedback }
						: { afterPlanFeedback: feedback };
				return this.dispatch(cardId, { type: "retry", ...gate, hasVerifyCommand: this.verifyCommandFor(cardId) !== null });
			}
		}
		return this.dispatch(cardId, { type: "answers_given", message });
	}

	retry(cardId: string, feedback?: string): Card {
		// Resting in testing with a pass already on record (an older Tower stopped here): go on, do not pay to test again.
		const card = getCard(this.deps.db, cardId);
		const lastTest = listRunsForCard(this.deps.db, cardId).findLast((run) => run.stage === "testing" && (run.kind === "verify" || run.kind === "stage"));
		if (card?.stage === "testing" && card.status === "idle" && !feedback && lastTest?.resultStatus === "pass") {
			return this.dispatch(cardId, {
				type: "tests_already_passed",
				context: { requiredGates: this.gatesFor(cardId), hasVerifyCommand: this.verifyCommandFor(cardId) !== null, hasQuestions: false, hasReviewFlows: this.reviewFlowsFor(cardId).length > 0, afterPlanFlows: false, afterBuildFlows: false, budget: this.budgetFor(cardId), onFailure: { action: "needs_attention", reason: "" } },
			});
		}
		// "gate satisfied: ..." is the person overruling a failed hook whose verdict is already recorded —
		// a red gate honestly held before the fix landed, re-run mechanically into failure. The settle is
		// replayed to wherever the work would have gone, with the decision in the card's record.
		if (card?.status === "needs_attention" && feedback?.startsWith("gate satisfied:")) {
			const last = listRunsForCard(this.deps.db, cardId).findLast((run) => run.status === "settled" && run.resultStatus === "fail" && run.kind === "flow_step");
			const why = feedback.slice("gate satisfied:".length).trim();
			this.dispatch(cardId, { type: "hook_ruled_satisfied" });
			return this.replayPastBudget(cardId, { feedback: `The person ruled the failed gate satisfied: ${why}${last?.resultSummary ? ` (the gate had exited: ${last.resultSummary})` : ""}` }, true);
		}
		// Stuck on a declined budget: the person just raised or cleared it, so continue the settled work —
		// re-planning would charge the budget twice for one plan.
		if (card?.status === "needs_attention" && card.needsAttentionReason?.startsWith("Budget declined")) {
			this.dispatch(cardId, { type: "gate_decided", decision: "approve", feedback: "", gateKind: "budget" });
			return this.replayPastBudget(cardId, { feedback: "continuing now that the budget was raised or cleared" });
		}
		// Stuck on a failed hook flow: the fix is a rebuild with the gate's output, not another test run —
		// except a failed before-plan understanding, which reruns itself: planning has nothing to go on
		// without it. The person's feedback, when they added some, rides along with the gate's output.
			if (card && card.status === "needs_attention") {
				const last = listRunsForCard(this.deps.db, cardId).findLast((run) => run.status === "settled");
				if (last?.kind === "flow_step" && last.resultStatus !== "pass" && (last.stage === "planning" || last.stage === "testing")) {
					const summary = `${last.resultSummary ?? ""}${feedback ? `\n\nThe person added:\n${feedback}` : ""}`;
					const gate = last.id.includes(UNDERSTAND_FLOW)
						? { beforePlan: true }
						: last.stage === "testing"
							? { gateFeedback: `The after-build flows did not pass and must pass before testing:\n\n${summary}` }
							: { afterPlanFeedback: `The after-plan flows did not pass and must pass before the plan gate:\n\n${summary}` };
					return this.dispatch(cardId, { type: "retry", ...gate, hasVerifyCommand: this.verifyCommandFor(cardId) !== null });
				}
			}
		return this.dispatch(cardId, { type: "retry", ...(feedback ? { feedback } : {}), hasVerifyCommand: this.verifyCommandFor(cardId) !== null });
	}

	/** Stops whatever is running for the card: an agent session, a hook's command, or the verify command. */
	async abort(cardId: string): Promise<void> {
		const stopVerify = this.verifyAborts.get(cardId);
		if (listQueued(this.deps.db).some((queued) => queued.card.id === cardId)) {
			// Still waiting for a slot: take it off the queue.
			setQueuedEffect(this.deps.db, cardId, null);
			this.dispatch(cardId, { type: "run_aborted" });
		} else if (stopVerify) stopVerify();
		else {
			this.deps.flows.abort(cardId);
			await this.deps.stages.abort(cardId);
		}
		await this.settled(cardId);
	}

	/** Stops starting work and kills verify commands without recording how they ended, so the next boot can recover them. */
	beginShutdown(): void {
		this.stopping = true;
		if (this.prTimer) clearInterval(this.prTimer);
		if (this.issueTimer) clearInterval(this.issueTimer);
		if (this.scheduleTimer) clearInterval(this.scheduleTimer);
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
		// A rejection carries the person's margin notes even when they typed nothing: the notes are the
		// what-should-change, and they land in the gate's record and the next attempt alike.
		const composed = decision === "reject" ? feedbackWithAnnotations(feedback, paths.cardDir(this.deps.config, cardId)) : feedback;
		// Transition first: if it is invalid nothing is recorded.
		const card =
			gate.kind === "budget" && decision === "approve"
				? this.replayPastBudget(cardId, gate)
				: this.dispatch(cardId, { type: "gate_decided", decision, feedback: composed, gateKind: gate.kind });
		decideGate(this.deps.db, gateId, decision === "approve" ? "approved" : "rejected", composed || null);
		this.deps.bus.publish({ topic: "board", type: "gate_decided", data: { cardId, gateId, decision } });
		return card;
	}

	/** The budget gate approved: the work settled clean and the person says continue, so the settle is
	 *  replayed exactly as it was, minus the budget — hooks, gates, testing all recompute as they were.
	 *  `skipHooks` serves the gate-satisfied ruling: the failed hook's verdict is overruled, not re-run. */
	private replayPastBudget(cardId: string, gate: { feedback: string | null }, skipHooks = false): Card {
		const card = getCard(this.deps.db, cardId) as Card;
		const afterPlanFlows = !skipHooks && card.stage === "planning" && this.triggeredFlows("after-plan", card.projectId).length > 0;
		const afterBuildFlows = !skipHooks && card.stage === "building" && this.triggeredFlows("after-build", card.projectId).length > 0;
		return this.dispatch(cardId, {
			type: "run_settled",
			result: "pass",
			summary: gate.feedback ?? "Continuing past the budget.",
			context: {
				requiredGates: this.gatesFor(cardId),
				hasVerifyCommand: this.verifyCommandFor(cardId) !== null,
				hasQuestions: false,
				hasReviewFlows: this.reviewFlowsFor(cardId).length > 0,
				afterPlanFlows,
				afterBuildFlows,
				budget: null,
				onFailure: this.failureDecision(cardId, gate.feedback ?? "", null),
			},
		});
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
			// Hooks only matter where they can run: an after-plan set for a passing plan, after-build for a passing build.
			const card = getCard(this.deps.db, cardId);
			const afterPlanFlows = outcome.result === "pass" && card?.stage === "planning" && this.triggeredFlows("after-plan", card.projectId).length > 0;
			const afterBuildFlows = outcome.result === "pass" && card?.stage === "building" && this.triggeredFlows("after-build", card.projectId).length > 0;
			this.dispatch(cardId, {
				type: "run_settled",
				result: outcome.result,
				summary: outcome.summary,
				// Gathered here, with IO, so that transition() can stay pure.
				context: {
					requiredGates: outcome.result === "pass" ? this.gatesFor(cardId) : [],
					hasVerifyCommand: this.verifyCommandFor(cardId) !== null,
					hasQuestions: outcome.hasQuestions,
					hasReviewFlows: this.reviewFlowsFor(cardId).length > 0,
					afterPlanFlows,
					afterBuildFlows,
					budget: this.budgetFor(cardId),
					onFailure: this.failureDecision(cardId, outcome.summary, this.previousTestFailure(cardId)),
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

	/** The review flows this card's project runs after tests pass. */
	private reviewFlowsFor(cardId: string): string[] {
		const card = getCard(this.deps.db, cardId);
		const project = card && getProject(this.deps.db, card.projectId);
		if (project?.reviewFlows) return project.reviewFlows;
		// An explicit setting wins (empty = off); otherwise every flow that asks for the after-tests trigger runs.
		if (this.deps.config.defaultReviewFlows !== null) return this.deps.config.defaultReviewFlows;
		return this.triggeredFlows("after-tests");
	}

	/** The flows that run at a lifecycle moment, whatever their source directory. Acceptance gates run only where opted in. */
	private triggeredFlows(trigger: FlowTrigger, projectId?: string): string[] {
		const project = projectId ? getProject(this.deps.db, projectId) : null;
		return flowsTriggered(loadFlows(this.deps.config), trigger)
			.filter((flow) => this.flowAllowed(flow, project))
			.map((flow) => flow.name);
	}

	/** Everything runs wherever its trigger asks, except the shipped acceptance gates, which a project must opt into. */
	private flowAllowed(flow: Flow, project: Project | null): boolean {
		if (!ACCEPTANCE_FLOWS.has(flow.name)) return true;
		return (project?.acceptanceGates ?? this.deps.config.acceptanceGates) === true;
	}

	private verifyCommandFor(cardId: string): string | null {
		const card = getCard(this.deps.db, cardId);
		return (card && getProject(this.deps.db, card.projectId)?.verifyCommand) || null;
	}

	/** The card's spend against the project's per-card budget, as a note for the person, or null when
	 *  there is no budget, it is not reached, or a person already approved continuing past it. */
	private budgetFor(cardId: string): string | null {
		const card = getCard(this.deps.db, cardId);
		const project = card ? getProject(this.deps.db, card.projectId) : null;
		if (!project?.budgetUsd) return null;
		const spent = listRunsForCard(this.deps.db, cardId).reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
		if (spent < project.budgetUsd) return null;
		if (listGatesForCard(this.deps.db, cardId).some((gate) => gate.kind === "budget" && gate.status === "approved")) return null;
		const usd = (amount: number) => `$${amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
		return `spent ${usd(spent)} of the ${usd(project.budgetUsd)} per-card budget`;
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

	/** The last testing failure this card recorded (agent tester or verify), for repetition-aware retries. */
	private previousTestFailure(cardId: string): string | null {
		const last = listRunsForCard(this.deps.db, cardId).findLast((run) => run.stage === "testing" && (run.kind === "verify" || run.kind === "stage") && run.resultStatus === "fail");
		return last?.resultSummary ?? null;
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
			const gate = { id: randomUUID().slice(0, 8), cardId, kind: effect.kind, createdAt: Date.now(), feedback: "note" in effect ? effect.note ?? null : null };
			insertGate(this.deps.db, gate);
			this.deps.bus.publish({ topic: "board", type: "gate_opened", data: gate });
			return;
		}
		if (effect.type === "cleanup_worktree") {
			// Tracked like any other work, so shutdown and tests wait for it.
			const work = this.cleanup(cardId).finally(() => this.pending.delete(work));
			this.pending.add(work);
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
			const landed = new Set(listLandedIds(db));
			const state: SchedulerState = {
				ready: queued.map(({ card, queuedAt }): ReadyCard => ({
					cardId: card.id,
					projectId: card.projectId,
					stage: card.stage,
					priority: card.priority,
					queuedAt,
					buildAttempt: countRunsForStage(db, card.id, "building"),
					waitingOn: card.dependsOn,
				})),
				running: [...executing.map((card) => ({ cardId: card.id, projectId: card.projectId })), ...[...this.launching].map(([cardId, projectId]) => ({ cardId, projectId }))],
				caps: { global: config.maxConcurrent, perProject: Object.fromEntries(listProjects(db).map((project) => [project.id, project.concurrencyLimit])) },
				landed,
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
		if (effect.type === "open_gate" || effect.type === "cleanup_worktree") return;
		const { stages } = this.deps;
		setQueuedEffect(this.deps.db, card.id, null);
		this.launching.set(card.id, card.projectId);
		const started =
			effect.type === "run_verify"
				? this.verify(card.id)
				: effect.type === "run_flows"
						? effect.phase
							? this.hookFlows(card.id, effect.phase, effect.feedback)
							: this.review(card.id, effect.feedback)
					: effect.type === "open_pr"
						? this.finishBranch(card.id)
						: (effect.type === "resume_run"
								? stages.resume(card.id, effect.stage, effect.message)
								: stages.start(card.id, effect.stage, { ...(effect.feedback ? { feedback: effect.feedback } : {}), ...(effect.fixingCi ? { fixingCi: true } : {}) })
							).then(() => {});
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

	/** Runs the project's review flows, then hands the card to the feedback gate. */
	/** Runs the project's review flows, then hands the card to the feedback gate. `feedback` carries a
	 *  person's answers from a review that stopped to ask, so the rerun's agents act on the decision. */
	private async review(cardId: string, feedback?: string): Promise<void> {
		this.launching.delete(cardId);
		this.dispatch(cardId, { type: "flows_started" });
		const names = this.reviewFlowsFor(cardId);
		const project = getProject(this.deps.db, getCard(this.deps.db, cardId)?.projectId ?? "");
		// Reviews never see each other, so a project that opts in runs them at the same time.
		const outcome =
			project?.parallelReviews === true && names.length > 1
				? await this.deps.flows.runFlowsConcurrently(cardId, names)
				: await this.deps.flows.runFlows(cardId, names, feedback);
		if (this.stopping) return;
		if (outcome.kind === "aborted") this.dispatch(cardId, { type: "run_aborted" });
		else if (outcome.kind === "failed") this.dispatch(cardId, { type: "run_failed", error: outcome.error });
		// A review that stopped to ask the person something parks the card on those questions, answerable
		// like any stage's — the answers ride the rerun as feedback.
		else if (outcome.result === "blocked" && outcome.hasQuestions)
			this.dispatch(cardId, {
				type: "run_settled",
				result: "blocked",
				summary: outcome.summary,
				context: {
					requiredGates: this.gatesFor(cardId),
					hasVerifyCommand: this.verifyCommandFor(cardId) !== null,
					hasQuestions: true,
					hasReviewFlows: this.reviewFlowsFor(cardId).length > 0,
					afterPlanFlows: false,
					afterBuildFlows: false,
					budget: this.budgetFor(cardId),
					onFailure: this.failureDecision(cardId, outcome.summary, null),
				},
			});
		// A review that finds blocking problems has done its job; whether to act on them is the person's call at the gate.
		else this.dispatch(cardId, { type: "flows_finished" });
	}

	/**
	 * Runs a lifecycle hook. After-plan and after-build flows guard the plan and the build; the before-plan
	 * hook guards planning itself — it builds the project's system model, promotes it, and only then may
	 * planning start. Unlike reviews, a hook that does not pass stops the card — deterministic gates exist
	 * to be satisfied, not weighed.
	 */
	private async hookFlows(cardId: string, phase: "before_plan" | "after_plan" | "after_build", feedback?: string): Promise<void> {
		this.launching.delete(cardId);
		this.dispatch(cardId, { type: "hook_started" });
		const names = phase === "before_plan" ? [UNDERSTAND_FLOW] : this.triggeredFlows(phase === "after_plan" ? "after-plan" : "after-build", getCard(this.deps.db, cardId)?.projectId);
		const outcome = await this.deps.flows.runFlows(cardId, names, feedback);
		if (this.stopping) return;
		if (outcome.kind === "aborted") return void this.dispatch(cardId, { type: "run_aborted" });
		if (outcome.kind === "failed") return void this.dispatch(cardId, { type: "run_failed", error: outcome.error });
		let passed = outcome.result === "pass";
		let reason: string;
		if (phase === "before_plan") {
			if (!passed) {
				reason = `The before-plan understanding did not pass:\n\n${outcome.summary}`;
			} else {
				// The model must actually land before planning may use it; a failed promotion fails the hook.
				try {
					await this.promoteUnderstanding(cardId);
					reason = "";
				} catch (error) {
					passed = false;
					reason = `The before-plan understanding finished but its model could not be saved: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		} else {
			reason = passed ? "" : `The ${phase === "after_plan" ? "after-plan" : "after-build"} flows did not pass:\n\n${outcome.summary}`;
		}
		this.dispatch(cardId, {
			type: "hook_finished",
			passed,
			reason,
			...(phase === "before_plan" ? { phase: "before_plan" as const } : {}),
			context: {
				requiredGates: this.gatesFor(cardId),
				hasVerifyCommand: this.verifyCommandFor(cardId) !== null,
				hasQuestions: false,
				hasReviewFlows: this.reviewFlowsFor(cardId).length > 0,
				afterPlanFlows: false,
				afterBuildFlows: false,
				budget: this.budgetFor(cardId),
				onFailure: this.failureDecision(cardId, outcome.summary, null),
			},
		});
	}

	/** Copies the understanding run's report to the project's system model, stamped with the commit it describes. */
	private async promoteUnderstanding(cardId: string): Promise<void> {
		const card = getCard(this.deps.db, cardId) as Card;
		const project = getProject(this.deps.db, card.projectId);
		if (!project) throw new Error("The card's project is gone");
		await promoteSystemModel({
			config: this.deps.config,
			projectId: project.id,
			repoPath: project.repoPath,
			defaultBranch: project.defaultBranch,
			cardId,
			reportPath: join(paths.cardDir(this.deps.config, cardId), "reviews", `${UNDERSTAND_FLOW}.md`),
		});
	}

	/** Runs a flow, skill, agent or prompt the person asked for. The card's place in its lifecycle does not change. */
	async adhoc(cardId: string, request: { flow?: string } & AdhocRequest): Promise<void> {
		if (this.isBusy(cardId)) throw new ConflictError("Something is already running for this card");
		const { flow, ...adhoc } = request;
		if (flow) this.deps.flows.flow(flow);
		const work = (flow ? this.deps.flows.runFlows(cardId, [flow]) : this.deps.flows.runAdhoc(cardId, adhoc))
			.then(() => this.deps.bus.publish({ topic: "board", type: "card_upserted", data: getCard(this.deps.db, cardId) }))
			.catch((error) => console.error(`ad hoc run failed for card ${cardId}:`, error))
			.finally(() => this.pending.delete(work));
		this.pending.add(work);
		// Wait until the session exists, so the caller can open it straight away.
		for (let i = 0; i < 200 && !this.deps.runs.liveRunForCard(cardId) && this.pending.has(work); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	}

	/**
	 * The card's finish line. With an `origin` remote: push the branch and open its pull request (or just push when one
	 * exists). Without one there is nowhere to open a pull request, so Tower merges the branch into the default branch
	 * itself — a real merge commit, the way the person would have.
	 */
	private async finishBranch(cardId: string): Promise<void> {
		const { config, db } = this.deps;
		const card = getCard(db, cardId) as Card;
		const project = getProject(db, card.projectId);
		if (!project || !card.worktreePath || !card.branchName) throw new Error("This card has no branch to open a pull request from");

		const remotes = await listRemotes(project.repoPath);
		if (!remotes.includes("origin")) {
			const merge = await mergeBranchLocally({
				repoPath: project.repoPath,
				branch: card.branchName,
				defaultBranch: project.defaultBranch,
				message: `Merge branch '${card.branchName}' (card ${cardId}: ${card.title})`,
			});
			console.log(`card ${cardId}: merged ${card.branchName} into ${project.defaultBranch} (${merge.via === "checkout" ? "in the checkout" : "by moving the ref"})`);
			this.dispatch(cardId, { type: "merged_locally", note: `Merged into ${project.defaultBranch} locally — no pull request, nowhere to open one. The work is on ${project.defaultBranch}.` });
			// The issue lives on the feedback repo, which gh reaches by name; nothing here depends on this project's remotes.
			if (card.issueNumber) {
				try {
					await closeIssue(this.deps.config.feedbackRepo, card.issueNumber, `Tower merged the fix for this (\`${merge.commit.slice(0, 10)}\` on ${project.defaultBranch}) locally — the repository it was built in has no origin remote, so the work landed without a pull request. Reopen if it persists.`);
				} catch (error) {
					console.error(`card ${cardId}: could not close issue #${card.issueNumber}:`, error instanceof Error ? error.message : error);
				}
			}
			return;
		}

		await pushBranch(card.worktreePath, "origin", card.branchName);
		const existing = await viewPullRequest(card.worktreePath, card.branchName);
		const bodyFile = join(paths.cardDir(config, cardId), "pr-body.md");
		const url = existing?.state === "OPEN" ? existing.url : await createPullRequest({ cwd: card.worktreePath, title: card.title, body: this.pullRequestBody(card), base: project.defaultBranch, head: card.branchName, bodyFile });
		const updated = updateCard(db, cardId, { prUrl: url, prState: "OPEN" });
		this.deps.bus.publish({ topic: "board", type: "card_upserted", data: updated });
		if (card.issueNumber) {
			// Tell the reporter their issue is taken on; merging the pull request closes it via "Fixes #N".
			const commentFile = join(paths.cardDir(config, cardId), "issue-comment.md");
			try {
				await commentOnIssue(this.deps.config.feedbackRepo, card.issueNumber, `Tower took this on — the pull request is up: ${url}. Merging it closes this issue.`, commentFile);
			} catch (error) {
				console.error(`card ${cardId}: could not comment on issue #${card.issueNumber}:`, error instanceof Error ? error.message : error);
			}
		}
		this.dispatch(cardId, { type: "pr_opened" });
	}

	private pullRequestBody(card: Card): string {
		const runs = listRunsForCard(this.deps.db, card.id).filter((run) => run.resultSummary);
		const last = (pick: (run: StageRun) => boolean) => runs.findLast(pick)?.resultSummary;
		const reviews = runs.filter((run) => run.kind === "flow_step").map((run) => `- ${run.id.replace(`c${card.id}-`, "").replace(/-\d+$/, "")}: ${run.resultSummary}`);
		return [
			card.brief,
			"## What was done",
			last((run) => run.kind === "stage" && run.stage === "building") ?? "See the commits.",
			"## Checks",
			last((run) => run.kind === "verify" || (run.kind === "stage" && run.stage === "testing")) ?? "Not recorded.",
			...(reviews.length > 0 ? ["## Reviews", reviews.join("\n")] : []),
			...(card.issueNumber ? [`Fixes #${card.issueNumber}.`] : []),
			"",
			"Opened by [Tower](https://tower.rahultrikha.com) after a human approved the work.",
		]
			.filter((part) => part !== "")
			.join("\n\n");
	}

	/** Checks every open pull request once: merged, closed, or failing CI that a builder should repair. */
	async pollPullRequests(): Promise<void> {
		for (const card of listWatchedPullRequests(this.deps.db)) {
			try {
				const pr = await viewPullRequest(card.worktreePath ?? ".", card.prUrl as string);
				if (!pr || this.stopping) continue;
				if (pr.state === "MERGED") this.dispatch(card.id, { type: "pr_merged" });
				else if (pr.state === "CLOSED") this.dispatch(card.id, { type: "pr_closed" });
				else if (pr.failedChecks.length > 0 && !pr.checksPending && this.handledCiFailures.get(card.id) !== pr.headSha) {
					this.handledCiFailures.set(card.id, pr.headSha);
					const fixes = listRunsForCard(this.deps.db, card.id).filter((run) => run.id.includes("-cifix-")).length;
					if (fixes >= this.deps.config.maxCiFixAttempts) {
						const updated = updateCard(this.deps.db, card.id, { status: "needs_attention", needsAttentionReason: `CI is still failing after ${fixes} repair attempts: ${pr.failedChecks.map((check) => check.name).join(", ")}` });
						this.deps.bus.publish({ topic: "board", type: "card_upserted", data: updated });
					} else {
						const checks = pr.failedChecks.map((check) => `- ${check.name}${check.url ? ` (${check.url})` : ""}`).join("\n");
						this.dispatch(card.id, { type: "ci_failed", feedback: `Failing checks on ${pr.url}:\n${checks}\n\nRead the logs with \`gh pr checks ${pr.url}\` and \`gh run view <run-id> --log-failed\`.` });
					}
				}
			} catch (error) {
				console.error(`could not check the pull request of card ${card.id}:`, error instanceof Error ? error.message : error);
			}
		}
	}

	/** Starts watching open pull requests. A poll is also worth doing right after boot. */
	watchPullRequests(): void {
		if (this.deps.config.prPollMs <= 0) return;
		this.prTimer = setInterval(() => void this.pollPullRequests(), this.deps.config.prPollMs);
		this.prTimer.unref();
	}

	/** Starts the scheduler: every tick, each project's scheduled flows whose interval has elapsed fire
	 *  on a carrier card. A check also runs right after boot, so an elapsed interval is not missed. */
	watchSchedule(): void {
		if (this.deps.config.scheduleTickMs <= 0) return;
		this.scheduleTimer = setInterval(() => void this.runScheduled(), this.deps.config.scheduleTickMs);
		this.scheduleTimer.unref();
		void this.runScheduled();
	}

	/** The project's scheduled flows, in file order. */
	private scheduledFlowsFor(projectId: string): Flow[] {
		const project = getProject(this.deps.db, projectId);
		return flowsTriggered(loadFlows(this.deps.config), "schedule").filter((flow) => this.flowAllowed(flow, project));
	}

	/** Fires every due scheduled flow on every project. A flow that cannot run without a worktree is
	 *  skipped with a log line: scheduled checks are read-only audits, not builds. */
	async runScheduled(): Promise<void> {
		const { config, db } = this.deps;
		const now = Date.now();
		for (const project of listProjects(db)) {
			const statePath = join(config.home, "projects", project.id, "schedule-state.json");
			let state: Record<string, number> = {};
			try {
				state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Record<string, number>) : {};
			} catch {
				state = {};
			}
			for (const flow of this.scheduledFlowsFor(project.id)) {
				const intervalMs = (flow.intervalHours ?? 24) * 3_600_000;
				const last = state[flow.name] ?? 0;
				if (now - last < intervalMs) continue;
				const title = `Scheduled: ${flow.title} — ${project.name}`;
				if (listCards(db).some((candidate) => candidate.projectId === project.id && candidate.title === title && this.isBusy(candidate.id))) continue;
				if (!runsOnBacklogCard(flow)) {
					console.error(`the scheduled flow "${flow.name}" runs commands or writes, which a carrier card cannot — it needs read-only steps`);
					continue;
				}
				const card = this.fileCard(project.id, title, `Fired by the scheduler for the "${flow.name}" flow. The run lands on this card; the flow works read-only in the project checkout.`);
				state[flow.name] = now;
				try {
					mkdirSync(dirname(statePath), { recursive: true });
					writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
				} catch (error) {
					console.error(`could not record the schedule state of ${project.name}:`, error instanceof Error ? error.message : error);
				}
				const work = this.deps.flows
					.runFlows(card.id, [flow.name])
					.then((outcome) => {
						if (outcome.kind === "failed") console.error(`the scheduled flow "${flow.name}" failed on ${project.name}: ${outcome.error}`);
					})
					.catch((error) => console.error(`the scheduled flow "${flow.name}" crashed on ${project.name}:`, error instanceof Error ? error.message : error));
				this.pending.add(work);
				work.finally(() => this.pending.delete(work));
			}
		}
	}

	/**
	 * Intake: open issues on the feedback repo become inert backlog cards on the project that tracks it.
	 * Nothing runs until a person approves the card, so a stranger's issue can only ever add a suggestion
	 * to the board.
	 */
	async pollIssues(): Promise<void> {
		const { config } = this.deps;
		let issues: Issue[];
		try {
			issues = await listIssues(config.feedbackRepo);
		} catch (error) {
			console.error(`intake: could not list issues on ${config.feedbackRepo}:`, error instanceof Error ? error.message : error);
			return;
		}
		const project = await this.intakeProject(config.feedbackRepo);
		if (!project) {
			if (issues.length > 0 && !this.warnedNoIntakeProject) {
				this.warnedNoIntakeProject = true;
				console.error(`intake: ${issues.length} open issue${issues.length === 1 ? "" : "s"} on ${config.feedbackRepo}, but no project on this board tracks that repository — add it as a project to turn issues into cards.`);
			}
			return;
		}
		for (const issue of issues) {
			if (this.stopping) return;
			try {
				this.intake(issue, project.id);
			} catch (error) {
				console.error(`intake: could not card issue #${issue.number}:`, error instanceof Error ? error.message : error);
			}
		}
	}

	/** The project whose origin is the feedback repo; issues become cards there. */
	private async intakeProject(feedbackRepo: string) {
		for (const project of listProjects(this.deps.db)) {
			if ((await originSlug(project.repoPath)) === feedbackRepo) return project;
		}
		return null;
	}

	private intake(issue: Issue, projectId: string): void {
		if (getCardByIssue(this.deps.db, issue.number)) return;
		const now = Date.now();
		const card: Card = {
			id: randomUUID().replaceAll("-", "").slice(0, 8),
			projectId,
			title: issue.title,
			brief: issueBrief(issue),
			stage: "backlog",
			status: "idle",
			priority: 0,
			position: now,
			branchName: null,
			worktreePath: null,
			baseCommit: null,
			attempt: 0,
			stageConfig: {},
			prUrl: null,
			prState: null,
			needsAttentionReason: null,
			finishNote: null,
			baseCardId: null,
			dependsOn: null,
			issueUrl: issue.url,
			issueNumber: issue.number,
			issueAuthor: issue.author,
			createdAt: now,
			updatedAt: now,
		};
		insertCard(this.deps.db, card);
		this.deps.bus.publish({ topic: "board", type: "card_upserted", data: card });
	}

	/** Starts watching the feedback repo's issues alongside the pull requests. */
	watchIssues(): void {
		if (this.deps.config.issuesPollMs <= 0) return;
		this.issueTimer = setInterval(() => void this.pollIssues(), this.deps.config.issuesPollMs);
		this.issueTimer.unref();
	}

	/** The card is finished: its worktrees go, and so does its branch when it merged locally (a pull request keeps it). */
	private async cleanup(cardId: string): Promise<void> {
		const card = getCard(this.deps.db, cardId);
		const project = card && getProject(this.deps.db, card.projectId);
		if (!card?.worktreePath || !project) return;
		try {
			// A card that was crewed has stream worktrees beside its own; they go with it.
			const streamWorktrees = streamWorktreePaths(dirname(card.worktreePath), card.id);
			await removeWorktree(project.repoPath, card.worktreePath);
			await Promise.all(streamWorktrees.map((path) => removeWorktree(project.repoPath, path)));
			// A locally merged card's work lives on the default branch; the label adds nothing once the worktree is gone.
			if (card.stage === "done" && !card.prUrl && card.branchName) await deleteMergedBranch(project.repoPath, card.branchName, project.defaultBranch);
		} catch (error) {
			console.error(`could not remove the worktree of card ${cardId}:`, error instanceof Error ? error.message : error);
		}
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
			questions: null,
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
			this.dispatch(cardId, {
				type: "verify_finished",
				passed: result.passed,
				context: {
					requiredGates: this.gatesFor(cardId),
					hasVerifyCommand: true,
					hasQuestions: false,
					hasReviewFlows: this.reviewFlowsFor(cardId).length > 0,
					afterPlanFlows: false,
					afterBuildFlows: false,
					budget: this.budgetFor(cardId),
					onFailure: this.failureDecision(cardId, result.output, previous),
				},
			});
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
