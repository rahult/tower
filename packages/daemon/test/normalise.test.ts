import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalise } from "../src/pi/normalise.ts";
import type { DriverEvent } from "../src/pi/session-driver.ts";

// Real pi 0.85.1 RPC output recorded by spikes/rpc-spike.ts.
const raw = readFileSync(join(import.meta.dirname, "fixtures", "spike-events.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as { type: string });
const events = raw.flatMap(normalise);
const ofType = <T extends DriverEvent["type"]>(type: T) => events.filter((e): e is Extract<DriverEvent, { type: T }> => e.type === type);

describe("normalise (against recorded pi output)", () => {
	it("maps every settle, and only settles on agent_settled", () => {
		expect(ofType("settled")).toHaveLength(raw.filter((e) => e.type === "agent_settled").length);
	});

	it("streams text and thinking deltas", () => {
		expect(ofType("text").map((e) => e.delta).join("")).toContain("Both done");
		expect(ofType("thinking").length).toBeGreaterThan(0);
	});

	it("pairs tool starts and ends by id and extracts output text", () => {
		const starts = ofType("tool_start");
		const ends = ofType("tool_end");
		expect(new Set(ends.map((e) => e.id))).toEqual(new Set(starts.map((e) => e.id)));
		expect(ends.find((e) => e.name === "write")?.output).toContain("Successfully wrote");
	});

	it("builds authoritative messages with tool calls", () => {
		const assistant = ofType("message").find((e) => e.message.role === "assistant" && e.message.toolCalls.length > 0);
		expect(assistant?.message.toolCalls[0]).toMatchObject({ name: "write", args: { path: "hello.txt" } });
		expect(ofType("message").some((e) => e.message.role === "toolResult" && e.message.toolCallId)).toBe(true);
	});

	it("reports the steering queue", () => {
		expect(ofType("queue")[0]?.steering[0]).toContain("Change of plan");
	});

	it("marks only dialog methods as blocking", () => {
		const ui = ofType("ui_request");
		expect(ui.find((e) => e.method === "confirm")).toMatchObject({ blocking: true, payload: { title: "Proceed?" } });
		expect(ui.find((e) => e.method === "notify")).toMatchObject({ blocking: false });
	});

	it("drops events the daemon does not use", () => {
		expect(normalise({ type: "turn_start" })).toEqual([]);
		expect(normalise({ type: "agent_end" })).toEqual([]);
	});
});
