import { describe, expect, it } from "vitest";
import { decideAfterFailure } from "../src/index.ts";

// Pins the contract only. The rule itself is a product decision (see the TODO in src/policy/retry.ts).
describe("decideAfterFailure", () => {
	const base = { maxBuildAttempts: 3, output: "1 test failed: expected 2, got 3", previousOutput: null };

	it("never retries once the attempt cap is reached, and says why", () => {
		for (const buildAttempt of [3, 4]) {
			const decision = decideAfterFailure({ ...base, buildAttempt });
			expect(decision.action).toBe("needs_attention");
			if (decision.action === "needs_attention") expect(decision.reason).not.toBe("");
		}
	});

	it("gives the builder something to act on when it retries", () => {
		const decision = decideAfterFailure({ ...base, buildAttempt: 1 });
		if (decision.action === "retry") expect(decision.feedback).toContain("expected 2, got 3");
	});
});
