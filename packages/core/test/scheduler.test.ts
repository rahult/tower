import { describe, expect, it } from "vitest";
import { eligible, pickNext, type ReadyCard, type SchedulerState } from "../src/index.ts";

const ready = (cardId: string, projectId: string, queuedAt: number, waitingOn: string | null = null): ReadyCard => ({ cardId, projectId, stage: "planning", priority: 0, queuedAt, buildAttempt: 0, waitingOn });
const state = (partial: Partial<SchedulerState>): SchedulerState => ({ ready: [], running: [], caps: { global: 2, perProject: {} }, landed: new Set(), ...partial });

describe("eligible", () => {
	it("offers nothing once the global cap is reached", () => {
		const s = state({ ready: [ready("c", "p3", 1)], running: [{ cardId: "a", projectId: "p1" }, { cardId: "b", projectId: "p2" }] });
		expect(eligible(s)).toEqual([]);
	});

	it("holds back cards whose project is at its cap (default 1), but not other projects", () => {
		const s = state({ ready: [ready("b", "p1", 1), ready("c", "p2", 2)], running: [{ cardId: "a", projectId: "p1" }] });
		expect(eligible(s).map((c) => c.cardId)).toEqual(["c"]);
	});

	it("honours a raised per-project cap", () => {
		const s = state({ ready: [ready("b", "p1", 1)], running: [{ cardId: "a", projectId: "p1" }], caps: { global: 3, perProject: { p1: 2 } } });
		expect(eligible(s).map((c) => c.cardId)).toEqual(["b"]);
	});

	it("holds a card back until the card it waits for has landed, then releases it", () => {
		const waiting = ready("b", "p1", 2, "a");
		const s = state({ ready: [waiting], running: [] });
		expect(eligible(s)).toEqual([]);
		const s2 = state({ ready: [waiting], running: [], landed: new Set(["a"]) });
		expect(eligible(s2).map((c) => c.cardId)).toEqual(["b"]);
	});

	it("a dependency holds its dependent back but never advances it past the caps", () => {
		const s = state({ ready: [ready("b", "p1", 1, "a"), ready("c", "p1", 2)], running: [{ cardId: "a", projectId: "p1" }], caps: { global: 4, perProject: { p1: 2 } } });
		// "a" is still running, so "b" waits; the freed slot goes to "c".
		expect(eligible(s).map((c) => c.cardId)).toEqual(["c"]);
	});
});

// Pins the contract only. The rule itself is a product decision (see the TODO in src/policy/scheduler.ts).
describe("pickNext", () => {
	it("returns null when nothing may start", () => {
		expect(pickNext([], state({}))).toBeNull();
	});

	it("only ever picks one of the candidates it was offered", () => {
		const candidates = [ready("a", "p1", 5), ready("b", "p2", 3)];
		expect(candidates.map((c) => c.cardId)).toContain(pickNext(candidates, state({ ready: candidates })));
	});
});
