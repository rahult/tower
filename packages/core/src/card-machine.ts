import type { GateKind } from "./policy/gates.ts";
import type { FailureDecision } from "./policy/retry.ts";
import type { AgentStage, CardStatus, ResultStatus, Stage } from "./types.ts";

/** The slice of a card the lifecycle rules depend on. */
export interface CardState {
	stage: Stage;
	status: CardStatus;
	needsAttentionReason: string | null;
}

export type CardEvent =
	| { type: "enqueue"; /** Set when the project wants its system model (re)built before this planning starts. */ understandFirst?: boolean }
	| { type: "run_started" }
	| { type: "run_settled"; result: ResultStatus; summary: string; context: SettleContext }
	| { type: "verify_finished"; passed: boolean; context: SettleContext }
	/** The card is resting in testing with a passing result already on record; carry on without testing again. */
	| { type: "tests_already_passed"; context: SettleContext }
	| { type: "flows_started" }
	| { type: "flows_finished" }
	/** A lifecycle hook (a before-plan, after-plan or after-build flow) is running. */
	| { type: "hook_started" }
	/** The card's lifecycle hooks finished. `reason` carries the failing step's summary when they did not pass. */
	| { type: "hook_finished"; passed: boolean; reason: string; context: SettleContext; /** A before-plan hook guards planning itself; the others guard the plan or the build. */ phase?: "before_plan" }
	| { type: "pr_opened" }
	/** There is nowhere to open a pull request (no remote); the branch is left for the person to merge. */
	| { type: "pr_skipped"; note: string }
	/** No origin remote, so Tower merged the branch into the default branch itself. */
	| { type: "merged_locally"; note: string }
	| { type: "pr_merged" }
	| { type: "pr_closed" }
	| { type: "ci_failed"; feedback: string }
	| { type: "run_failed"; error: string }
	| { type: "run_aborted" }
	| { type: "gate_decided"; decision: "approve" | "reject"; feedback: string; /** Which gate was decided, when it is not the stage's usual one (the budget gate). */ gateKind?: GateKind }
	| { type: "retry"; feedback?: string; hasVerifyCommand?: boolean; /** Set when the stuck work is a failed after-build gate: rebuild with this as feedback. */ gateFeedback?: string; /** Set when the stuck work is a failed after-plan gate: rerun the gate's flows with this as feedback, not the plan. */ afterPlanFeedback?: string; /** Set when the stuck work is a failed before-plan understanding: rerun it, not the plan. */ beforePlan?: boolean }
	/** The daemon restarted while this card's work was in flight. */
	| { type: "daemon_restarted" }
	/** `wasVerifying`: the interrupted work was the verify command, which has no session to reopen. */
	| { type: "resume"; wasVerifying: boolean }
	/** The person answered the questions a stage asked. `message` is what the agent is told. */
	| { type: "answers_given"; message: string };

/** Facts the orchestrator gathers (with IO) so the transition itself can stay pure. */
export interface SettleContext {
	requiredGates: GateKind[];
	/** The project has a verify command, so the daemon (not an agent) decides whether testing passes. */
	hasVerifyCommand: boolean;
	/** The stage stopped with specific questions for a person. */
	hasQuestions: boolean;
	/** The project has review flows to run once tests pass. */
	hasReviewFlows: boolean;
	/** Flows triggered after the plan passes, before the plan gate or building. */
	afterPlanFlows: boolean;
	/** Flows triggered after the build passes, before testing. */
	afterBuildFlows: boolean;
	/** What the retry policy says to do if this settle is a testing failure. */
	onFailure: FailureDecision;
	/** The card's spend has reached the project's per-card budget (prebuilt note), so the pipeline pauses for a person. */
	budget: string | null;
}

export type Effect =
	/** `fixingCi`: a build run that repairs a failing pull request; the card stays in its pull request stage. */
	| { type: "start_run"; stage: AgentStage; feedback?: string; fixingCi?: boolean }
	/** `phase`: which lifecycle moment the flows belong to. Absent: the post-test reviews. `feedback`: what a previous failed run of this hook said, so the rerun's agents fix the cause. */
	| { type: "run_flows"; phase?: "before_plan" | "after_plan" | "after_build"; feedback?: string }
	/** The finish line: push the branch and open its pull request — or, with no origin remote, merge it locally. */
	| { type: "open_pr" }
	| { type: "cleanup_worktree" }
	/** Reopen the stage's session (same session id). Without a message the agent is told to carry on after an interruption. */
	| { type: "resume_run"; stage: AgentStage; message?: string }
	| { type: "run_verify" }
	| { type: "open_gate"; kind: GateKind; /** For the budget gate: the spend note the person sees at the gate. */ note?: string };

export interface Transition {
	next: CardState;
	effects: Effect[];
}

export class InvalidTransition extends Error {
	constructor(card: CardState, event: CardEvent) {
		super(`Cannot apply "${event.type}" to a card that is ${card.stage}/${card.status}`);
	}
}

const AGENT_STAGES = new Set<Stage>(["planning", "building", "testing"]);
const isAgentStage = (stage: Stage): stage is AgentStage => AGENT_STAGES.has(stage);

const rest = (stage: Stage, status: CardStatus, needsAttentionReason: string | null = null): CardState => ({ stage, status, needsAttentionReason });
const afterTestFailure = (decision: FailureDecision): Transition =>
	decision.action === "retry" ? queue("building", decision.feedback) : { next: rest("testing", "needs_attention", decision.reason), effects: [] };

/** Tests are green: review, then the human, then the pull request, skipping whatever is not configured. */
const afterTestsPass = (context: SettleContext): Transition => {
	if (context.hasReviewFlows) return { next: rest("feedback", "queued"), effects: [{ type: "run_flows" }] };
	return afterReviews(context.requiredGates);
};
const afterReviews = (gates: GateKind[]): Transition =>
	gates.includes("feedback") ? { next: rest("feedback", "awaiting_gate"), effects: [{ type: "open_gate", kind: "feedback" }] } : openPr();
const openPr = (): Transition => ({ next: rest("pull_request", "queued"), effects: [{ type: "open_pr" }] });
/** A plan that passed (and its hooks, when they ran): the human gate if wanted, otherwise building. */
const afterPlanningPass = (context: SettleContext): Transition =>
	context.requiredGates.includes("plan_approval")
		? { next: rest("planning", "awaiting_gate"), effects: [{ type: "open_gate", kind: "plan_approval" }] }
		: queue("building");

const queue = (stage: AgentStage, feedback?: string): Transition => ({
	next: rest(stage, "queued"),
	effects: [{ type: "start_run", stage, ...(feedback ? { feedback } : {}) }],
});

/**
 * The card lifecycle. Pure: no IO, no clock. The daemon's orchestrator is the only caller and the only executor
 * of the returned effects. Throws InvalidTransition for events that make no sense in the current state.
 */
export function transition(card: CardState, event: CardEvent): Transition {
	const { stage, status } = card;
	switch (event.type) {
		case "enqueue":
			if (stage === "backlog" && status === "idle") {
				// The project's system model is built first — read-only, no worktree — then planning starts.
				if (event.understandFirst) return { next: rest("planning", "queued"), effects: [{ type: "run_flows", phase: "before_plan" }] };
				return queue("planning");
			}
			break;

		case "run_started":
			if (status === "queued") return { next: rest(stage, "running"), effects: [] };
			break;

		case "run_settled": {
			if (status !== "running") break;
			// A tester that reports failure is the loop's signal, not a dead end: the retry policy decides.
			if (stage === "testing" && event.result === "fail") return afterTestFailure(event.context.onFailure);
			// Questions are answerable, so they get their own state and the session is kept to continue in.
			if (event.result === "blocked" && event.context.hasQuestions) return { next: rest(stage, "awaiting_input", event.summary), effects: [] };
			if (event.result !== "pass") {
				const reason = event.result === "missing" ? event.summary : `${event.result}: ${event.summary}`;
				return { next: rest(stage, "needs_attention", reason), effects: [] };
			}
			if (stage === "planning") {
				if (event.context.budget) return { next: rest(stage, "running"), effects: [{ type: "open_gate", kind: "budget", note: event.context.budget }] };
				if (event.context.afterPlanFlows) return { next: rest("planning", "queued"), effects: [{ type: "run_flows", phase: "after_plan" }] };
				return afterPlanningPass(event.context);
			}
			if (stage === "building") {
				if (event.context.budget) return { next: rest(stage, "running"), effects: [{ type: "open_gate", kind: "budget", note: event.context.budget }] };
				if (event.context.afterBuildFlows) return { next: rest("testing", "queued"), effects: [{ type: "run_flows", phase: "after_build" }] };
				return event.context.hasVerifyCommand ? { next: rest("testing", "verifying"), effects: [{ type: "run_verify" }] } : queue("testing");
			}
			if (stage === "testing") return afterTestsPass(event.context);
			// A build that repaired the pull request: push it again and go back to watching.
			if (stage === "pull_request") return openPr();
			break;
		}

		case "verify_finished":
			if (stage !== "testing" || status !== "verifying") break;
			return event.passed ? afterTestsPass(event.context) : afterTestFailure(event.context.onFailure);

		case "tests_already_passed":
			if (stage === "testing" && status === "idle") return afterTestsPass(event.context);
			break;

		case "flows_started":
			if (stage === "feedback" && status === "queued") return { next: rest("feedback", "running"), effects: [] };
			break;

		case "flows_finished":
			// The feedback gate is the one a person should not skip lightly, so it is always asked for here.
			if (stage === "feedback" && status === "running") return afterReviews(["feedback"]);
			break;

		case "hook_started":
			if (status === "queued" && (stage === "planning" || stage === "testing")) return { next: rest(stage, "running"), effects: [] };
			break;

		case "hook_finished": {
			if (status !== "running" || (stage !== "planning" && stage !== "testing")) break;
			if (!event.passed) return { next: rest(stage, "needs_attention", event.reason), effects: [] };
			if (stage === "planning") {
				// A before-plan hook guards planning itself: with it satisfied, planning simply starts.
				if (event.phase === "before_plan") return queue("planning");
				return afterPlanningPass(event.context);
			}
			return event.context.hasVerifyCommand ? { next: rest("testing", "verifying"), effects: [{ type: "run_verify" }] } : queue("testing");
		}

		case "pr_opened":
			if (stage === "pull_request" && (status === "queued" || status === "running")) return { next: rest("pull_request", "idle"), effects: [] };
			break;

		case "pr_skipped":
			if (stage === "pull_request") return { next: rest("done", "idle", event.note), effects: [{ type: "cleanup_worktree" }] };
			break;

		case "merged_locally":
			if (stage === "pull_request") return { next: rest("done", "idle", event.note), effects: [{ type: "cleanup_worktree" }] };
			break;

		case "pr_merged":
			if (stage === "pull_request") return { next: rest("done", "idle"), effects: [{ type: "cleanup_worktree" }] };
			break;

		case "pr_closed":
			if (stage === "pull_request") return { next: rest("pull_request", "needs_attention", "The pull request was closed without being merged."), effects: [] };
			break;

		case "ci_failed":
			if (stage !== "pull_request" || status !== "idle") break;
			return { next: rest("pull_request", "queued"), effects: [{ type: "start_run", stage: "building", feedback: event.feedback, fixingCi: true }] };

		case "run_failed":
			if (status === "running" || status === "queued" || status === "verifying") return { next: rest(stage, "needs_attention", event.error), effects: [] };
			break;

		case "run_aborted":
			if (status === "running" || status === "queued" || status === "verifying") return { next: rest(stage, "idle"), effects: [] };
			break;

		case "gate_decided":
			if (event.gateKind === "budget") {
				// Approve at the gate never reaches the machine: the orchestrator replays the settle
				// without the budget. A decline is a real stop — the card is sound but unfunded — and
				// approving again after the budget was raised hands the card back to its settle.
				if (event.decision === "reject" && status === "running")
					return { next: rest(stage, "needs_attention", `Budget declined (${event.feedback || "no reason given"}). Raise or clear the budget in the project settings, then Retry to continue where it stopped.`), effects: [] };
				if (event.decision === "approve" && status === "needs_attention") return { next: rest(stage, "running"), effects: [] };
				break;
			}
			if (status !== "awaiting_gate") break;
			if (stage === "planning") return event.decision === "approve" ? queue("building") : queue("planning", event.feedback);
			if (stage === "feedback") return event.decision === "approve" ? openPr() : queue("building", event.feedback);
			break;

		case "daemon_restarted":
			if (status === "running" || status === "verifying") return { next: rest(stage, "interrupted"), effects: [] };
			break;

		case "resume":
			if (status !== "interrupted" || !isAgentStage(stage)) break;
			if (event.wasVerifying) return { next: rest("testing", "verifying"), effects: [{ type: "run_verify" }] };
			return { next: rest(stage, "queued"), effects: [{ type: "resume_run", stage }] };

		case "answers_given":
			if (status !== "awaiting_input" || !isAgentStage(stage)) break;
			return { next: rest(stage, "queued"), effects: [{ type: "resume_run", stage, message: event.message }] };

		case "retry":
			// Re-run the stage the card is stuck or resting in, optionally with guidance.
			if (stage === "feedback" && (status === "needs_attention" || status === "idle")) return { next: rest("feedback", "queued"), effects: [{ type: "run_flows" }] };
			if (stage === "pull_request" && (status === "needs_attention" || status === "idle")) return openPr();
			if (!isAgentStage(stage) || (status !== "needs_attention" && status !== "idle" && status !== "interrupted" && status !== "awaiting_input")) break;
			// A failed before-plan understanding reruns itself: planning must not start without its model.
			if (stage === "planning" && event.beforePlan) return { next: rest("planning", "queued"), effects: [{ type: "run_flows", phase: "before_plan" }] };
			// A failed after-plan gate reruns its flows with the failure as feedback: the specs were wrong,
			// not the plan, and re-planning would pay twice for one gate's opinion.
			if (stage === "planning" && event.afterPlanFeedback !== undefined) return { next: rest("planning", "queued"), effects: [{ type: "run_flows", phase: "after_plan", feedback: event.afterPlanFeedback }] };
			// A failed after-build gate is repaired by rebuilding, not by re-testing: the gate output is the feedback.
			if (stage === "testing" && event.gateFeedback !== undefined) return queue("building", event.gateFeedback);
			if (stage === "testing" && event.hasVerifyCommand) return { next: rest("testing", "verifying"), effects: [{ type: "run_verify" }] };
			return queue(stage, event.feedback);
			break;
	}
	throw new InvalidTransition(card, event);
}
