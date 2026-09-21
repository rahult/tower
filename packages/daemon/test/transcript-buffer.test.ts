import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptBuffer, type TranscriptItem } from "../src/run/transcript-buffer.ts";

describe("TranscriptBuffer", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const make = (maxItems?: number) => {
		const emitted: Array<{ item: TranscriptItem; durable: boolean }> = [];
		const buffer = new TranscriptBuffer({ flushMs: 50, maxItems, onItem: (item, durable) => emitted.push({ item, durable }), now: () => 1 });
		return { buffer, emitted };
	};

	it("coalesces deltas into one non-durable item per flush window", () => {
		const { buffer, emitted } = make();
		buffer.pushDelta("text", "Hel");
		buffer.pushDelta("text", "lo");
		expect(emitted).toHaveLength(0);
		vi.advanceTimersByTime(50);
		expect(emitted).toEqual([{ item: { seq: 1, ts: 1, type: "text", payload: { delta: "Hello" } }, durable: false }]);
	});

	it("flushes pending deltas before a durable item, preserving order", () => {
		const { buffer, emitted } = make();
		buffer.pushDelta("thinking", "hmm");
		buffer.pushDelta("text", "ok");
		buffer.push("tool_start", { name: "bash" });
		expect(emitted.map((e) => [e.item.seq, e.item.type, e.durable])).toEqual([
			[1, "thinking", false],
			[2, "text", false],
			[3, "tool_start", true],
		]);
	});

	it("replays items after a cursor", () => {
		const { buffer } = make();
		for (let i = 0; i < 4; i++) buffer.push("note", { i });
		expect(buffer.snapshot(2).items.map((item) => item.seq)).toEqual([3, 4]);
		expect(buffer.lastSeq).toBe(4);
	});

	it("drops the oldest items past the cap and reports the watermark", () => {
		const { buffer } = make(3);
		for (let i = 0; i < 5; i++) buffer.push("note", { i });
		const snapshot = buffer.snapshot(0);
		expect(snapshot.items.map((item) => item.seq)).toEqual([3, 4, 5]);
		expect(snapshot.droppedBefore).toBe(3);
	});
});
