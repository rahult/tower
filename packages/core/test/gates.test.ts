import { describe, expect, it } from "vitest";
import { requiredGates } from "../src/index.ts";

// Pins the contract only. The rule itself is a product decision (see the TODO in src/policy/gates.ts).
describe("requiredGates", () => {
	it("returns only known gate kinds, without duplicates", () => {
		const gates = requiredGates({ card: { title: "Fix typo", brief: "", planningAttempt: 1 }, plan: { bytes: 400, lines: 12 } });
		expect(new Set(gates).size).toBe(gates.length);
		for (const gate of gates) expect(["plan_approval", "feedback"]).toContain(gate);
	});
});
