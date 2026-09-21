export interface FailureContext {
	/** How many times this card has been built so far (1 after the first build). */
	buildAttempt: number;
	maxBuildAttempts: number;
	/** Output of the failing check: the verify command's output, or the tester's summary. */
	output: string;
	/** Output of the previous failing check, when this is not the first failure. */
	previousOutput: string | null;
}

export type FailureDecision =
	/** Send the card back to building. `feedback` is what the builder is told. */
	| { action: "retry"; feedback: string }
	/** Stop and ask the human. `reason` is shown on the card. */
	| { action: "needs_attention"; reason: string };

const TAIL_CHARS = 6000;

/**
 * Decides what happens after testing fails.
 *
 * The trade-off: a pure counter is honest but dumb; it burns every attempt on a missing dependency that no
 * rebuild can fix. Comparing this failure with the previous one ("same error twice means the builder is stuck")
 * stops sooner, but needs a similarity rule and can give up on a flaky test. And how much output do you feed
 * back: all of it (the answer is in there, but it bloats a cheap model's context) or just the tail?
 *
 * TODO(rahul): replace this default (counter only, last 6000 characters) with your own rule.
 * Tests in test/retry.test.ts pin only the contract: never retry past the cap, always say why.
 */
export function decideAfterFailure(ctx: FailureContext): FailureDecision {
	if (ctx.buildAttempt >= ctx.maxBuildAttempts) {
		return { action: "needs_attention", reason: `Still failing after ${ctx.buildAttempt} build attempts.` };
	}
	return { action: "retry", feedback: `The checks failed after your last build. Fix the cause, do not weaken the checks.\n\n${ctx.output.slice(-TAIL_CHARS)}` };
}
