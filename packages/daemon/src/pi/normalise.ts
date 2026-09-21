import type { DriverEvent, TranscriptMessage } from "./session-driver.ts";

type Raw = { type: string; [key: string]: unknown };
type ContentBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };

/** extension_ui_request methods that block the agent until answered. The rest are fire-and-forget. */
const BLOCKING_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

const MAX_TOOL_OUTPUT = 4000;

function blocksOf(content: unknown): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function textOf(content: unknown): string {
	return blocksOf(content)
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");
}

function toMessage(raw: Record<string, unknown>): TranscriptMessage | null {
	const role = raw.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
	const blocks = blocksOf(raw.content);
	return {
		role,
		text: textOf(raw.content),
		thinking: blocks
			.filter((b) => b.type === "thinking")
			.map((b) => b.thinking ?? "")
			.join(""),
		toolCalls: blocks.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id ?? "", name: b.name ?? "", args: b.arguments })),
		...(role === "toolResult"
			? { toolCallId: raw.toolCallId as string, toolName: raw.toolName as string, isError: raw.isError === true }
			: {}),
	};
}

/** Pure translation of one raw pi RPC event into zero or more DriverEvents. */
export function normalise(raw: Raw): DriverEvent[] {
	switch (raw.type) {
		case "message_update": {
			const inner = raw.assistantMessageEvent as { type: string; delta?: string } | undefined;
			if (inner?.type === "text_delta" && inner.delta) return [{ type: "text", delta: inner.delta }];
			if (inner?.type === "thinking_delta" && inner.delta) return [{ type: "thinking", delta: inner.delta }];
			return [];
		}
		case "message_end": {
			const message = toMessage(raw.message as Record<string, unknown>);
			return message ? [{ type: "message", message }] : [];
		}
		case "tool_execution_start":
			return [{ type: "tool_start", id: raw.toolCallId as string, name: raw.toolName as string, args: raw.args }];
		case "tool_execution_end": {
			const output = textOf((raw.result as { content?: unknown } | undefined)?.content);
			return [
				{
					type: "tool_end",
					id: raw.toolCallId as string,
					name: raw.toolName as string,
					isError: raw.isError === true,
					output: output.length > MAX_TOOL_OUTPUT ? `${output.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated]` : output,
				},
			];
		}
		case "queue_update":
			return [{ type: "queue", steering: (raw.steering as string[]) ?? [], followUp: (raw.followUp as string[]) ?? [] }];
		case "extension_ui_request": {
			const { type: _type, id, method, ...payload } = raw;
			return [{ type: "ui_request", id: id as string, method: method as string, blocking: BLOCKING_UI_METHODS.has(method as string), payload }];
		}
		case "agent_settled":
			return [{ type: "settled" }];
		default:
			return [];
	}
}
