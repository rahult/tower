import { describe, expect, it } from "vitest";
import { applyItem, type Block, describeTool, type TranscriptItem } from "../src/card/transcript-model.ts";

let seq = 0;
const item = (type: string, payload: unknown): TranscriptItem => ({ seq: ++seq, ts: 0, type, payload });
const fold = (items: TranscriptItem[]) => items.reduce<Block[]>(applyItem, []);
const assistant = (text: string, thinking = "") => item("message", { message: { role: "assistant", text, thinking, toolCalls: [] } });

describe("applyItem", () => {
	it("accumulates deltas into one streaming block, then settles it with the authoritative message", () => {
		const blocks = fold([
			item("prompt", { text: "Plan it" }),
			item("thinking", { delta: "Hm" }),
			item("text", { delta: "Pl" }),
			item("text", { delta: "an" }),
			assistant("Plan.", "Hmm"),
		]);
		expect(blocks).toMatchObject([
			{ kind: "prompt", text: "Plan it" },
			{ kind: "assistant", text: "Plan.", thinking: "Hmm", streaming: false },
		]);
	});

	it("builds the same blocks from a cold replay that has no deltas", () => {
		const blocks = fold([item("prompt", { text: "Plan it" }), assistant("Plan.", "Hmm")]);
		expect(blocks).toMatchObject([{ kind: "prompt" }, { kind: "assistant", text: "Plan.", thinking: "Hmm", streaming: false }]);
	});

	it("skips assistant messages that only carried tool calls, and non-assistant messages", () => {
		const blocks = fold([assistant(""), item("message", { message: { role: "user", text: "x" } }), item("message", { message: { role: "toolResult", text: "y" } })]);
		expect(blocks).toEqual([]);
	});

	it("completes a tool call in place and keeps its arguments", () => {
		const blocks = fold([
			item("tool_start", { id: "t1", name: "bash", args: { command: "ls" } }),
			item("tool_end", { id: "t1", name: "bash", isError: true, output: "boom" }),
		]);
		expect(blocks).toMatchObject([{ kind: "tool", id: "t1", args: { command: "ls" }, output: "boom", isError: true }]);
	});

	it("starts a new assistant block after a tool call instead of appending to the settled one", () => {
		const blocks = fold([item("text", { delta: "a" }), assistant("a"), item("tool_start", { id: "t", name: "ls", args: {} }), item("text", { delta: "b" })]);
		expect(blocks.map((b) => b.kind)).toEqual(["assistant", "tool", "assistant"]);
		expect(blocks[2]).toMatchObject({ text: "b", streaming: true });
	});

	it("shows steers and the end of the session; ignores bookkeeping items", () => {
		const blocks = fold([item("steer", { text: "shorter" }), item("queue", {}), item("settled", {}), item("run_finished", { status: "settled" })]);
		expect(blocks).toMatchObject([{ kind: "steer", text: "shorter" }, { kind: "note", text: "Finished: settled." }]);
	});
});

describe("provider errors", () => {
	it("shows why the model could not answer instead of an empty reply", () => {
		const blocks = fold([item("prompt", { text: "Plan" }), item("message", { message: { role: "assistant", text: "", thinking: "", toolCalls: [], error: "Out of usage (HTTP 400)" } })]);
		expect(blocks).toMatchObject([{ kind: "prompt" }, { kind: "note", text: "The model could not answer: Out of usage (HTTP 400)" }]);
	});
});

describe("extension questions", () => {
	it("shows a blocking dialog until it is resolved, and ignores notifications", () => {
		const asked = fold([item("ui_request", { id: "u1", method: "confirm", blocking: true, payload: { title: "Run it?" } }), item("ui_request", { id: "u2", method: "notify", blocking: false, payload: {} })]);
		expect(asked).toMatchObject([{ kind: "ui", id: "u1", method: "confirm", outcome: null }]);
		expect(applyItem(asked, item("ui_resolved", { id: "u1", outcome: "expired" }))).toMatchObject([{ kind: "ui", outcome: "expired" }]);
	});
});

describe("verify runs", () => {
	it("accumulates the command's output into one block", () => {
		const blocks = fold([
			item("verify_started", { command: "pnpm test" }),
			item("verify_output", { text: "running…\n" }),
			item("verify_output", { text: "1 failed\n" }),
			item("run_finished", { status: "Verify command exited with code 1." }),
		]);
		expect(blocks).toMatchObject([
			{ kind: "verify", command: "pnpm test", output: "running…\n1 failed\n" },
			{ kind: "note", text: "Finished: Verify command exited with code 1." },
		]);
	});
});

describe("describeTool", () => {
	it("prefers the command or path", () => {
		expect(describeTool("bash", { command: "pnpm test" })).toBe("bash pnpm test");
		expect(describeTool("read", { path: "a.ts" })).toBe("read a.ts");
		expect(describeTool("ls", null)).toBe("ls");
		expect(describeTool("write", { path: "/a/b/c/home/cards/x1/plan.md" })).toBe("write …/cards/x1/plan.md");
	});
});
