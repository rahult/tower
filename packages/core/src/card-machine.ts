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
	| { type: "enqueue" }
	| { type: "run_started" }
	| { type: "run_settled"; result: ResultStatus; summary: string; context: SettleContext }
	| { type: "verify_finished"; passed: boolean; context: SettleContext }
	/** The card is resting in testing with a passing result already on record; carry on without testing again. */
	| { type: "tests_already_passed"; context: SettleContext }
	| { type: "flows_started" }
	| { type: "flows_finished" }
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
	| { type: "gate_decided"; decision: "approve" | "reject"; feedback: string }
	| { type: "retry"; feedback?: string; hasVerifyCommand?: boolean }
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
	/** What the retry policy says to do if this settle is a testing failure. */
	onFailure: FailureDecision;
}

export type Effect =
	/** `fixingCi`: a build run that repairs a failing pull request; the card stays in its pull request stage. */
	| { type: "start_run"; stage: AgentStage; feedback?: string; fixingCi?: boolean }
	| { type: "run_flows" }
	/** The finish line: push the branch and open its pull request — or, with no origin remote, merge it locally. */
	| { type: "open_pr" }
	| { type: "cleanup_worktree" }
	/** Reopen the stage's session (same session id). Without a message the agent is told to carry on after an interruption. */
	| { type: "resume_run"; stage: AgentStage; message?: string }
	| { type: "run_verify" }
	| { type: "open_gate"; kind: GateKind };

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
			if (stage === "backlog" && status === "idle") return queue("planning");
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
				return event.context.requiredGates.includes("plan_approval")
					? { next: rest("planning", "awaiting_gate"), effects: [{ type: "open_gate", kind: "plan_approval" }] }
					: queue("building");
			}
			if (stage === "building") {
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
			if (stage === "testing" && event.hasVerifyCommand) return { next: rest("testing", "verifying"), effects: [{ type: "run_verify" }] };
			return queue(stage, event.feedback);
			break;
	}
	throw new InvalidTransition(card, event);
}
