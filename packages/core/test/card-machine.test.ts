import { describe, expect, it } from "vitest";
import { type CardEvent, type CardState, InvalidTransition, type SettleContext, transition } from "../src/index.ts";

const card = (stage: CardState["stage"], status: CardState["status"]): CardState => ({ stage, status, needsAttentionReason: null });
const RETRY = { action: "retry", feedback: "2 tests failed" } as const;
const GIVE_UP = { action: "needs_attention", reason: "Still failing after 3 build attempts." } as const;
const settled = (
	result: "pass" | "fail" | "blocked" | "missing",
	summary = "",
	context: Partial<SettleContext> = {},
): CardEvent => ({
	type: "run_settled",
	result,
	summary,
	context: { requiredGates: ["plan_approval", "feedback"], hasVerifyCommand: false, onFailure: RETRY, ...context },
});

describe("transition", () => {
	it.each<[string, CardState, CardEvent, Partial<CardState>, unknown[]]>([
		["enqueue starts planning", card("backlog", "idle"), { type: "enqueue" }, { stage: "planning", status: "queued" }, [{ type: "start_run", stage: "planning" }]],
		["a started run is running", card("planning", "queued"), { type: "run_started" }, { status: "running" }, []],
		["a good plan waits for approval", card("planning", "running"), settled("pass"), { stage: "planning", status: "awaiting_gate" }, [{ type: "open_gate", kind: "plan_approval" }]],
		["a good plan builds straight away when the policy skips the gate", card("planning", "running"), settled("pass", "", { requiredGates: ["feedback"] }), { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building" }]],
		["approval starts building", card("planning", "awaiting_gate"), { type: "gate_decided", decision: "approve", feedback: "" }, { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building" }]],
		["rejection re-plans with the feedback", card("planning", "awaiting_gate"), { type: "gate_decided", decision: "reject", feedback: "Too broad" }, { stage: "planning", status: "queued" }, [{ type: "start_run", stage: "planning", feedback: "Too broad" }]],
		["a finished build is verified by the daemon when the project has a verify command", card("building", "running"), settled("pass", "", { hasVerifyCommand: true }), { stage: "testing", status: "verifying" }, [{ type: "run_verify" }]],
		["a finished build goes to a tester agent when there is no verify command", card("building", "running"), settled("pass"), { stage: "testing", status: "queued" }, [{ type: "start_run", stage: "testing" }]],
		["passing verification rests in testing", card("testing", "verifying"), { type: "verify_finished", passed: true, onFailure: RETRY }, { stage: "testing", status: "idle" }, []],
		["failing verification loops back to building with the output", card("testing", "verifying"), { type: "verify_finished", passed: false, onFailure: RETRY }, { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building", feedback: "2 tests failed" }]],
		["failing verification stops when the policy gives up", card("testing", "verifying"), { type: "verify_finished", passed: false, onFailure: GIVE_UP }, { stage: "testing", status: "needs_attention", needsAttentionReason: GIVE_UP.reason }, []],
		["a tester that reports failure loops back the same way", card("testing", "running"), settled("fail", "red"), { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building", feedback: "2 tests failed" }]],
		["a tester that passes rests", card("testing", "running"), settled("pass"), { stage: "testing", status: "idle" }, []],
		["a blocked tester asks the human, it does not loop", card("testing", "running"), settled("blocked", "No test runner"), { stage: "testing", status: "needs_attention" }, []],
		["a verify command that cannot run asks for attention", card("testing", "verifying"), { type: "run_failed", error: "spawn ENOENT" }, { status: "needs_attention", needsAttentionReason: "spawn ENOENT" }, []],
		["a failed stage asks for attention", card("building", "running"), settled("fail", "tests red"), { status: "needs_attention", needsAttentionReason: "fail: tests red" }, []],
		["a blocked stage surfaces the question", card("planning", "running"), settled("blocked", "Which DB?"), { status: "needs_attention", needsAttentionReason: "blocked: Which DB?" }, []],
		["a missing result explains itself", card("planning", "running"), settled("missing", "stage-result.json was not written"), { needsAttentionReason: "stage-result.json was not written" }, []],
		["a crash asks for attention", card("building", "running"), { type: "run_failed", error: "pi exited 1" }, { status: "needs_attention", needsAttentionReason: "pi exited 1" }, []],
		["a run that never started asks for attention", card("planning", "queued"), { type: "run_failed", error: "bad auth" }, { status: "needs_attention" }, []],
		["abort rests the card in its stage", card("building", "running"), { type: "run_aborted" }, { stage: "building", status: "idle" }, []],
		["retry re-runs the stuck stage with guidance", card("building", "needs_attention"), { type: "retry", feedback: "Use pnpm" }, { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building", feedback: "Use pnpm" }]],
		["retrying testing re-runs the verify command when there is one", card("testing", "needs_attention"), { type: "retry", hasVerifyCommand: true }, { stage: "testing", status: "verifying" }, [{ type: "run_verify" }]],
		["aborting a verification rests the card", card("testing", "verifying"), { type: "run_aborted" }, { stage: "testing", status: "idle" }, []],
		["retry works on a resting stage", card("planning", "idle"), { type: "retry" }, { status: "queued" }, [{ type: "start_run", stage: "planning" }]],
	])("%s", (_name, from, event, expected, effects) => {
		const { next, effects: actual } = transition(from, event);
		expect(next).toMatchObject(expected);
		expect(actual).toEqual(effects);
	});

	it("clears a stale attention reason when the card moves on", () => {
		const stuck: CardState = { stage: "planning", status: "needs_attention", needsAttentionReason: "old" };
		expect(transition(stuck, { type: "retry" }).next.needsAttentionReason).toBeNull();
	});

	it.each<[string, CardState, CardEvent]>([
		["enqueue a card that already left the backlog", card("planning", "idle"), { type: "enqueue" }],
		["decide a gate that is not open", card("planning", "running"), { type: "gate_decided", decision: "approve", feedback: "" }],
		["settle a run on a card that is not running", card("planning", "awaiting_gate"), settled("pass")],
		["retry a running card", card("building", "running"), { type: "retry" }],
		["retry a backlog card", card("backlog", "idle"), { type: "retry" }],
		["abort a resting card", card("building", "idle"), { type: "run_aborted" }],
		["finish a verification that is not running", card("testing", "idle"), { type: "verify_finished", passed: true, onFailure: RETRY }],
	])("rejects: %s", (_name, from, event) => {
		expect(() => transition(from, event)).toThrow(InvalidTransition);
	});
});
