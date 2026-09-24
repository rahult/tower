import { describe, expect, it } from "vitest";
import { type CardEvent, type CardState, InvalidTransition, type SettleContext, transition } from "../src/index.ts";

const card = (stage: CardState["stage"], status: CardState["status"]): CardState => ({ stage, status, needsAttentionReason: null });
const RETRY = { action: "retry", feedback: "2 tests failed" } as const;
const GIVE_UP = { action: "needs_attention", reason: "Still failing after 3 build attempts." } as const;
const context = (partial: Partial<SettleContext> = {}): SettleContext => ({ requiredGates: ["plan_approval", "feedback"], hasVerifyCommand: false, hasQuestions: false, hasReviewFlows: false, afterPlanFlows: false, afterBuildFlows: false, onFailure: RETRY, ...partial });
const verified = (passed: boolean, partial: Partial<SettleContext> = {}): CardEvent => ({ type: "verify_finished", passed, context: context(partial) });
const settled = (
	result: "pass" | "fail" | "blocked" | "missing",
	summary = "",
	context: Partial<SettleContext> = {},
): CardEvent => ({
	type: "run_settled",
	result,
	summary,
	context: { requiredGates: ["plan_approval", "feedback"], hasVerifyCommand: false, hasQuestions: false, hasReviewFlows: false, afterPlanFlows: false, afterBuildFlows: false, onFailure: RETRY, ...context },
});

describe("transition", () => {
	it.each<[string, CardState, CardEvent, Partial<CardState>, unknown[]]>([
		["enqueue starts planning", card("backlog", "idle"), { type: "enqueue" }, { stage: "planning", status: "queued" }, [{ type: "start_run", stage: "planning" }]],
		["enqueue with understanding first runs the before-plan hook", card("backlog", "idle"), { type: "enqueue", understandFirst: true }, { stage: "planning", status: "queued" }, [{ type: "run_flows", phase: "before_plan" }]],
		["a started run is running", card("planning", "queued"), { type: "run_started" }, { status: "running" }, []],
		["a good plan waits for approval", card("planning", "running"), settled("pass"), { stage: "planning", status: "awaiting_gate" }, [{ type: "open_gate", kind: "plan_approval" }]],
		["a good plan builds straight away when the policy skips the gate", card("planning", "running"), settled("pass", "", { requiredGates: ["feedback"] }), { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building" }]],
		["approval starts building", card("planning", "awaiting_gate"), { type: "gate_decided", decision: "approve", feedback: "" }, { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building" }]],
		["rejection re-plans with the feedback", card("planning", "awaiting_gate"), { type: "gate_decided", decision: "reject", feedback: "Too broad" }, { stage: "planning", status: "queued" }, [{ type: "start_run", stage: "planning", feedback: "Too broad" }]],
		["a finished build is verified by the daemon when the project has a verify command", card("building", "running"), settled("pass", "", { hasVerifyCommand: true }), { stage: "testing", status: "verifying" }, [{ type: "run_verify" }]],
		["a finished build goes to a tester agent when there is no verify command", card("building", "running"), settled("pass"), { stage: "testing", status: "queued" }, [{ type: "start_run", stage: "testing" }]],
		["a good plan runs its after-plan hooks before anything else", card("planning", "running"), settled("pass", "", { afterPlanFlows: true }), { stage: "planning", status: "queued" }, [{ type: "run_flows", phase: "after_plan" }]],
		["a finished build runs its after-build gates before testing", card("building", "running"), settled("pass", "", { afterBuildFlows: true }), { stage: "testing", status: "queued" }, [{ type: "run_flows", phase: "after_build" }]],
		["a finished build runs its after-build gates before the verify command too", card("building", "running"), settled("pass", "", { afterBuildFlows: true, hasVerifyCommand: true }), { stage: "testing", status: "queued" }, [{ type: "run_flows", phase: "after_build" }]],
		["hooks that start are running", card("testing", "queued"), { type: "hook_started" }, { stage: "testing", status: "running" }, []],
		["passing after-plan hooks reach the plan gate", card("planning", "running"), { type: "hook_finished", passed: true, reason: "", context: context() }, { stage: "planning", status: "awaiting_gate" }, [{ type: "open_gate", kind: "plan_approval" }]],
		["a passing before-plan hook starts planning", card("planning", "running"), { type: "hook_finished", passed: true, reason: "", phase: "before_plan", context: context() }, { stage: "planning", status: "queued" }, [{ type: "start_run", stage: "planning" }]],
		["a failed before-plan hook stops the card", card("planning", "running"), { type: "hook_finished", passed: false, reason: "understand-system: the checkout has no readable source", phase: "before_plan", context: context() }, { stage: "planning", status: "needs_attention", needsAttentionReason: "understand-system: the checkout has no readable source" }, []],
		["passing after-plan hooks build straight away when the policy skips the gate", card("planning", "running"), { type: "hook_finished", passed: true, reason: "", context: context({ requiredGates: ["feedback"] }) }, { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building" }]],
		["passing after-build gates run the verify command when there is one", card("testing", "running"), { type: "hook_finished", passed: true, reason: "", context: context({ hasVerifyCommand: true }) }, { stage: "testing", status: "verifying" }, [{ type: "run_verify" }]],
		["passing after-build gates go to a tester agent when there is no verify command", card("testing", "running"), { type: "hook_finished", passed: true, reason: "", context: context() }, { stage: "testing", status: "queued" }, [{ type: "start_run", stage: "testing" }]],
		["a failed gate stops the card with the step's summary", card("testing", "running"), { type: "hook_finished", passed: false, reason: "size-limit: bundle grew 12% (run `pnpm size`)", context: context() }, { stage: "testing", status: "needs_attention", needsAttentionReason: "size-limit: bundle grew 12% (run `pnpm size`)" }, []],
		["retrying a failed after-build gate rebuilds with the gate output", card("testing", "needs_attention"), { type: "retry", gateFeedback: "size-limit: bundle grew 12%" }, { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building", feedback: "size-limit: bundle grew 12%" }]],
		["retrying a failed before-plan understanding reruns it", card("planning", "needs_attention"), { type: "retry", beforePlan: true, hasVerifyCommand: true }, { stage: "planning", status: "queued" }, [{ type: "run_flows", phase: "before_plan" }]],
		["passing verification rests in testing", card("testing", "verifying"), verified(true), { stage: "feedback", status: "awaiting_gate" }, [{ type: "open_gate", kind: "feedback" }]],
		["passing tests start the project's review flows first", card("testing", "verifying"), verified(true, { hasReviewFlows: true }), { stage: "feedback", status: "queued" }, [{ type: "run_flows" }]],
		["passing tests go straight to a pull request when nothing gates them", card("testing", "verifying"), verified(true, { requiredGates: [] }), { stage: "pull_request", status: "queued" }, [{ type: "open_pr" }]],
		["a card resting on a passing test moves on without testing again", card("testing", "idle"), { type: "tests_already_passed", context: context({ hasReviewFlows: true }) }, { stage: "feedback", status: "queued" }, [{ type: "run_flows" }]],
		["review flows that start are running", card("feedback", "queued"), { type: "flows_started" }, { stage: "feedback", status: "running" }, []],
		["finished reviews wait for the human", card("feedback", "running"), { type: "flows_finished" }, { stage: "feedback", status: "awaiting_gate" }, [{ type: "open_gate", kind: "feedback" }]],
		["approving the work opens a pull request", card("feedback", "awaiting_gate"), { type: "gate_decided", decision: "approve", feedback: "" }, { stage: "pull_request", status: "queued" }, [{ type: "open_pr" }]],
		["sending the work back rebuilds with the feedback", card("feedback", "awaiting_gate"), { type: "gate_decided", decision: "reject", feedback: "Fix finding 2" }, { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building", feedback: "Fix finding 2" }]],
		["an opened pull request is watched", card("pull_request", "queued"), { type: "pr_opened" }, { stage: "pull_request", status: "idle" }, []],
		["a merged pull request finishes the card and cleans up", card("pull_request", "idle"), { type: "pr_merged" }, { stage: "done", status: "idle" }, [{ type: "cleanup_worktree" }]],
		["without a remote the branch is left for the person", card("pull_request", "queued"), { type: "pr_skipped", note: "Branch tower/x is ready to merge." }, { stage: "done", status: "idle", needsAttentionReason: "Branch tower/x is ready to merge." }, [{ type: "cleanup_worktree" }]],
		["a local merge finishes the card and cleans up", card("pull_request", "queued"), { type: "merged_locally", note: "Merged into main locally." }, { stage: "done", status: "idle", needsAttentionReason: "Merged into main locally." }, [{ type: "cleanup_worktree" }]],
		["a closed pull request asks for attention", card("pull_request", "idle"), { type: "pr_closed" }, { stage: "pull_request", status: "needs_attention" }, []],
		["failing CI sends the logs to a builder without leaving the pull request stage", card("pull_request", "idle"), { type: "ci_failed", feedback: "lint failed" }, { stage: "pull_request", status: "queued" }, [{ type: "start_run", stage: "building", feedback: "lint failed", fixingCi: true }]],
		["a CI fix is pushed and watched again", card("pull_request", "running"), settled("pass"), { stage: "pull_request", status: "queued" }, [{ type: "open_pr" }]],
		["a CI fix that fails asks for attention", card("pull_request", "running"), settled("fail", "cannot reproduce"), { stage: "pull_request", status: "needs_attention" }, []],
		["retrying a stuck pull request opens it again", card("pull_request", "needs_attention"), { type: "retry" }, { stage: "pull_request", status: "queued" }, [{ type: "open_pr" }]],
		["retrying reviews runs the flows again", card("feedback", "needs_attention"), { type: "retry" }, { stage: "feedback", status: "queued" }, [{ type: "run_flows" }]],
		["failing verification loops back to building with the output", card("testing", "verifying"), verified(false), { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building", feedback: "2 tests failed" }]],
		["failing verification stops when the policy gives up", card("testing", "verifying"), verified(false, { onFailure: GIVE_UP }), { stage: "testing", status: "needs_attention", needsAttentionReason: GIVE_UP.reason }, []],
		["a tester that reports failure loops back the same way", card("testing", "running"), settled("fail", "red"), { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building", feedback: "2 tests failed" }]],
		["a tester that passes moves on to feedback", card("testing", "running"), settled("pass"), { stage: "feedback", status: "awaiting_gate" }, [{ type: "open_gate", kind: "feedback" }]],
		["a stage that asks questions waits for answers", card("planning", "running"), settled("blocked", "Two decisions change the plan.", { hasQuestions: true }), { stage: "planning", status: "awaiting_input", needsAttentionReason: "Two decisions change the plan." }, []],
		["answers continue the same session", card("planning", "awaiting_input"), { type: "answers_given", message: "1. CLI" }, { stage: "planning", status: "queued", needsAttentionReason: null }, [{ type: "resume_run", stage: "planning", message: "1. CLI" }]],
		["a card waiting for answers can also start its stage over", card("planning", "awaiting_input"), { type: "retry" }, { status: "queued" }, [{ type: "start_run", stage: "planning" }]],
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
		["a restart interrupts running work", card("building", "running"), { type: "daemon_restarted" }, { stage: "building", status: "interrupted" }, []],
		["a restart interrupts a verification", card("testing", "verifying"), { type: "daemon_restarted" }, { stage: "testing", status: "interrupted" }, []],
		["resume reopens the interrupted session", card("building", "interrupted"), { type: "resume", wasVerifying: false }, { stage: "building", status: "queued" }, [{ type: "resume_run", stage: "building" }]],
		["resuming an interrupted verification runs the command again", card("testing", "interrupted"), { type: "resume", wasVerifying: true }, { stage: "testing", status: "verifying" }, [{ type: "run_verify" }]],
		["an interrupted card can also start its stage over", card("building", "interrupted"), { type: "retry" }, { stage: "building", status: "queued" }, [{ type: "start_run", stage: "building" }]],
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
		["a restart does not touch a card that is waiting for a human", card("planning", "awaiting_gate"), { type: "daemon_restarted" }],
		["answer a card that asked nothing", card("planning", "needs_attention"), { type: "answers_given", message: "x" }],
		["resume a card that was not interrupted", card("building", "idle"), { type: "resume", wasVerifying: false }],
		["CI failing on a card that is already being fixed", card("pull_request", "running"), { type: "ci_failed", feedback: "x" }],
		["skip testing on a card that is still building", card("building", "idle"), { type: "tests_already_passed", context: context() }],
		["merge a card that has no pull request", card("building", "idle"), { type: "pr_merged" }],
		["finish a verification that is not running", card("testing", "idle"), verified(true)],
		["hooks that finish on a card that is not running them", card("testing", "idle"), { type: "hook_finished", passed: true, reason: "", context: context() }],
		["hooks that start on a card in the feedback stage", card("feedback", "queued"), { type: "hook_started" }],
	])("rejects: %s", (_name, from, event) => {
		expect(() => transition(from, event)).toThrow(InvalidTransition);
	});
});
