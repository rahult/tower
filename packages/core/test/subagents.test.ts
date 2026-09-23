import { describe, expect, it } from "vitest";
import { hasCrew, MAX_CREW_MEMBERS, parseCrewPlan } from "../src/subagents.ts";

const PLAN = `# Plan

## Context and goal

Wrap request() with retries.

## Steps

1. Add retry.ts.

## Scouts

- **transient-errors**: What does the gateway actually return on a timeout — 502, 504, or a hang?
  Check src/http/gateway.ts and the fixtures in test/gateway.

## Streams

- **client**: Add retry.ts with exponential backoff. Owns src/http/retry.ts only. Verify with pnpm test --filter http.
- **client-tests**: Table-driven tests for the backoff schedule. Owns test/retry.test.ts.

## Verify

- [ ] pnpm test
`;

describe("parseCrewPlan", () => {
	it("reads scouts and streams out of the plan, folding continuation lines into their bullet", () => {
		const crew = parseCrewPlan(PLAN);
		expect(crew.scouts.map((s) => s.slug)).toEqual(["transient-errors"]);
		expect(crew.scouts[0]?.text).toContain("fixtures in test/gateway");
		expect(crew.streams.map((s) => s.slug)).toEqual(["client", "client-tests"]);
		expect(crew.streams[0]?.text).toContain("exponential backoff");
		expect(hasCrew(crew)).toBe(true);
	});

	it("finds sections case-insensitively and normalizes slugs", () => {
		const crew = parseCrewPlan("## scouts\n\n- **ORM_Choice**: which one?\n");
		expect(crew.scouts[0]?.slug).toBe("orm-choice");
	});

	it("returns no crew for an ordinary plan", () => {
		const crew = parseCrewPlan("## Steps\n\n1. Do the thing.\n");
		expect(crew).toEqual({ scouts: [], streams: [] });
		expect(hasCrew(crew)).toBe(false);
	});

	it("ignores sections with no valid bullets, and headings that only look close", () => {
		expect(parseCrewPlan("## Streams\n\nNothing here.\n")).toEqual({ scouts: [], streams: [] });
		expect(parseCrewPlan("### Streams\n\n- **a**: too shallow\n").streams).toEqual([]);
	});

	it("does not let a runaway plan spawn a runaway crew", () => {
		const bullets = Array.from({ length: 12 }, (_, i) => `- **stream-${i}**: work`).join("\n");
		expect(parseCrewPlan(`## Streams\n\n${bullets}\n`).streams.length).toBe(MAX_CREW_MEMBERS);
	});

	it("stops a section at the next heading, so trailing sections do not leak in", () => {
		const crew = parseCrewPlan(PLAN);
		expect(crew.streams.some((s) => s.text.includes("[ ] pnpm test"))).toBe(false);
	});
});
