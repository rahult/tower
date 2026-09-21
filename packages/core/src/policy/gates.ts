export type GateKind = "plan_approval" | "feedback";

export interface RequiredGatesContext {
	card: {
		title: string;
		brief: string;
		/** How many times this card has been planned; > 1 means you already sent a plan back. */
		planningAttempt: number;
	};
	/** The plan the planner just wrote. */
	plan: { bytes: number; lines: number };
}

/**
 * Decides which human gates a card must pass. Called once, when planning succeeds.
 *
 * The trade-off: gating every card is safe but makes you the bottleneck this tool exists to remove; skipping
 * the plan gate for "small" work is what makes ten concurrent cards possible, but "small" is exactly the
 * judgement that is hard. Signals available: plan size, brief length, whether you already rejected a plan.
 * The feedback gate (before a PR opens) is the one you probably never want to skip.
 *
 * TODO(rahul): replace this default with your own rule. Tests in test/gates.test.ts pin only the contract
 * (returns known gate kinds), not the rule.
 */
export function requiredGates(_ctx: RequiredGatesContext): GateKind[] {
	return ["plan_approval", "feedback"];
}
