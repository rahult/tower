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

/** What the failure looks like to a comparison: whitespace-normalised, so formatting noise cannot fake a change. */
const signature = (output: string): string => output.replace(/\s+/g, " ").trim();

/**
 * Decides what happens after testing fails.
 *
 * The trade-off: a pure counter is honest but dumb; it burns every attempt on a missing dependency that no
 * rebuild can fix. Comparing this failure with the previous one ("same error twice means the builder is stuck")
 * stops sooner, but needs a similarity rule and can give up on a flaky test. And how much output do you feed
 * back: all of it (the answer is in there, but it bloats a cheap model's context) or just the tail?
 *
 * The default: a counter with a cap, the last 6000 characters of output, and one repetition signal — when this
 * failure is byte-for-byte the one before it (whitespace-normalised), the builder is told the last fix did not
 * touch the cause, because an identical failure after a fix is information, not bad luck.
 *
 * TODO(rahul): tune the similarity rule if flaky tests ever masquerade as identical failures.
 * Tests in test/retry.test.ts pin only the contract: never retry past the cap, always say why.
 */
export function decideAfterFailure(ctx: FailureContext): FailureDecision {
	if (ctx.buildAttempt >= ctx.maxBuildAttempts) {
		const identical = ctx.previousOutput !== null && signature(ctx.previousOutput) === signature(ctx.output);
		return {
			action: "needs_attention",
			reason: `Still failing after ${ctx.buildAttempt} build attempts${identical ? " — the last two failed identically, so the current approach is not working" : ""}.`,
		};
	}
	const identical = ctx.previousOutput !== null && signature(ctx.previousOutput) === signature(ctx.output);
	const warning = identical
		? "This failure is exactly the one your last fix claimed to address — the fix did not touch the cause. Change the approach: re-read the failing check, question the plan's assumption behind it, and verify your change actually runs before reporting."
		: "Fix the cause, do not weaken the checks.";
	return { action: "retry", feedback: `The checks failed after your last build. ${warning}\n\n${ctx.output.slice(-TAIL_CHARS)}` };
}
