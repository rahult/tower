import { describe, expect, it } from "vitest";
import { type CardEvent, type CardState, InvalidTransition, transition } from "../src/index.ts";

/**
 * No stuck states, proven by reachability: walking every transition the machine can take from the
 * real entry points, each (stage, status) cell the walk can reach must have at least one
 * human-invoked way out — retry, resume, or re-enqueue. done/idle is the one deliberate terminal
 * (deletion is its exit). feedback/interrupted once silently had no exit and a live restart walked
 * into it; this walk is how that class of bug stays dead.
 */

const STAGES = ["backlog", "planning", "building", "testing", "feedback", "pull_request", "done"] as const;
const STATUSES = ["idle", "queued", "running", "verifying", "awaiting_gate", "awaiting_input", "needs_attention", "paused", "interrupted", "abandoned"] as const;

/** Every way the product hands a person an exit: retry/resume buttons, re-enqueue, abort, the gate
 *  decisions, and the answer form for a stopped question. An event that does not apply to a cell
 *  simply throws InvalidTransition, which counts as "not an exit from here". */
const HUMAN_EXITS: CardEvent[] = [
	{ type: "retry" },
	{ type: "resume", wasVerifying: false },
	{ type: "resume", wasVerifying: true },
	{ type: "enqueue" },
	{ type: "run_aborted" },
	{ type: "answers_given", message: "the person's decision" },
	{ type: "gate_decided", decision: "approve", feedback: "" },
	{ type: "gate_decided", decision: "reject", feedback: "what should change" },
];

/** The settle context a well-configured card carries; the walk's stands in for the orchestrator's IO. */
const context = {
	requiredGates: ["plan_approval", "feedback"] as const,
	hasVerifyCommand: true,
	hasQuestions: false,
	hasReviewFlows: true,
	afterPlanFlows: false,
	afterBuildFlows: false,
	budget: null,
	onFailure: { action: "retry" as const, feedback: "the checks failed" },
};

/** The alphabet of events the walk explores. Lifecycle events that only fire from specific cells
 *  simply fail InvalidTransition elsewhere, which is the walk's way of saying "not from here". */
const EVENTS: CardEvent[] = [
	{ type: "enqueue" },
	{ type: "enqueue", understandFirst: true },
	{ type: "run_started" },
	{ type: "run_settled", result: "pass", summary: "", context },
	{ type: "run_settled", result: "fail", summary: "checks failed", context },
	{ type: "run_settled", result: "blocked", summary: "a question", context: { ...context, hasQuestions: true } },
	{ type: "verify_finished", passed: true, context },
	{ type: "verify_finished", passed: false, context },
	{ type: "tests_already_passed", context },
	{ type: "flows_started" },
	{ type: "flows_finished" },
	{ type: "hook_started" },
	{ type: "hook_finished", passed: true, reason: "", context },
	{ type: "hook_finished", passed: false, reason: "the hook did not pass", context },
	{ type: "pr_opened" },
	{ type: "pr_merged" },
	{ type: "pr_closed" },
	{ type: "ci_failed", feedback: "CI is red" },
	{ type: "run_failed", error: "boom" },
	{ type: "run_aborted" },
	{ type: "gate_decided", decision: "approve", feedback: "" },
	{ type: "gate_decided", decision: "reject", feedback: "again" },
	{ type: "daemon_restarted" },
	{ type: "resume", wasVerifying: false },
	{ type: "resume", wasVerifying: true },
	{ type: "retry" },
	{ type: "answers_given", message: "the answers" },
];

const apply = (state: CardState, event: CardEvent): CardState | null => {
	try {
		return transition(state, event).next;
	} catch (error) {
		if (error instanceof InvalidTransition) return null;
		throw error;
	}
};

describe("no stuck states (reachability walk)", () => {
	it("every reachable cell except the deliberate terminal has a human way out", () => {
		const start: CardState = { stage: "backlog", status: "idle", needsAttentionReason: null, finishNote: null, baseCardId: null };
		const seen = new Set<string>([key(start)]);
		const queue: CardState[] = [start];
		const humanExit = (state: CardState): boolean =>
			HUMAN_EXITS.some((event) => {
				try {
					transition(state, event);
					return true;
				} catch (error) {
					if (error instanceof InvalidTransition) return false;
					throw error;
				}
			});

		while (queue.length > 0) {
			const state = queue.shift() as CardState;
			for (const event of EVENTS) {
				const next = apply(state, event);
				if (!next) continue;
				const id = key(next);
				if (seen.has(id)) continue;
				seen.add(id);
				queue.push(next);
			}
		}

		const reachable = [...seen].sort();
		const stuck = reachable.filter((id) => {
			const [stage, status] = id.split("/");
			if (stage === "done" && status === "idle") return false;
			return !humanExit({ stage: stage as CardState["stage"], status: status as CardState["status"], needsAttentionReason: null, finishNote: null, baseCardId: null });
		});
		expect(stuck, `reachable cells with no human way out`).toEqual([]);
		// The walk has to have covered the board's interesting quarters, or it proves nothing.
		expect(reachable.filter((id) => id.startsWith("planning")).length).toBeGreaterThan(2);
		expect(reachable.filter((id) => id.startsWith("testing")).length).toBeGreaterThan(2);
		expect(reachable).toContain("feedback/awaiting_gate");
		expect(reachable).toContain("done/idle");
	});
});

const key = (state: CardState): string => `${state.stage}/${state.status}`;
