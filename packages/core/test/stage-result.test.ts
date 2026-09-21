import { describe, expect, it } from "vitest";
import { parseStageResult } from "../src/index.ts";

describe("parseStageResult", () => {
	it("accepts a valid result", () => {
		expect(parseStageResult('{"status":"pass","summary":"done"}')).toEqual({ ok: true, result: { status: "pass", summary: "done" } });
	});

	it("defaults a missing summary to empty", () => {
		expect(parseStageResult('{"status":"blocked"}')).toEqual({ ok: true, result: { status: "blocked", summary: "" } });
	});

	it.each([
		[null, "was not written"],
		["not json", "not valid JSON"],
		["[]", "invalid status"],
		['"pass"', "not an object"],
		['{"status":"great"}', "invalid status"],
	])("rejects %j", (raw, reason) => {
		const parsed = parseStageResult(raw);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.reason).toContain(reason);
	});

	it("keeps well-formed questions from a blocked stage", () => {
		const parsed = parseStageResult(
			JSON.stringify({
				status: "blocked",
				summary: "Two decisions change the plan.",
				questions: [
					{ question: "What kind of app?", options: ["CLI", "Web app", "  "] },
					{ question: "Which SQLite driver?" },
					{ question: "", options: ["x"] },
					"not a question",
				],
			}),
		);
		expect(parsed).toEqual({
			ok: true,
			result: {
				status: "blocked",
				summary: "Two decisions change the plan.",
				questions: [
					{ question: "What kind of app?", options: ["CLI", "Web app"] },
					{ question: "Which SQLite driver?", options: [] },
				],
			},
		});
	});

	it("ignores questions on a stage that is not blocked, and a questions field that is not a list", () => {
		expect(parseStageResult('{"status":"pass","summary":"ok","questions":[{"question":"?"}]}')).toEqual({ ok: true, result: { status: "pass", summary: "ok" } });
		expect(parseStageResult('{"status":"blocked","summary":"hm","questions":"what?"}')).toEqual({ ok: true, result: { status: "blocked", summary: "hm" } });
	});
});
