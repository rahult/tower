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
});
