export interface TranscriptItem {
	seq: number;
	ts: number;
	type: string;
	payload: any;
}

export type Block =
	| { kind: "prompt"; seq: number; text: string }
	| { kind: "steer"; seq: number; text: string }
	| { kind: "assistant"; seq: number; text: string; thinking: string; streaming: boolean }
	| { kind: "tool"; seq: number; id: string; name: string; args: unknown; output: string | null; isError: boolean }
	| { kind: "verify"; seq: number; command: string; output: string }
	| { kind: "note"; seq: number; text: string; tone?: "error" };

/**
 * Folds one transcript item into the block list. Pure, and the same for live streams and cold replays:
 * live runs send deltas then an authoritative `message`; finished runs send only the `message`.
 */
export function applyItem(blocks: Block[], item: TranscriptItem): Block[] {
	const { seq, type, payload } = item;
	switch (type) {
		case "prompt":
			return [...blocks, { kind: "prompt", seq, text: payload.text }];
		case "steer":
			return [...blocks, { kind: "steer", seq, text: payload.text }];
		case "text":
		case "thinking": {
			const last = blocks.at(-1);
			const open = last?.kind === "assistant" && last.streaming ? last : null;
			const base = open ?? { kind: "assistant" as const, seq, text: "", thinking: "", streaming: true };
			const next = { ...base, [type]: base[type] + payload.delta };
			return open ? [...blocks.slice(0, -1), next] : [...blocks, next];
		}
		case "message": {
			const message = payload.message;
			if (message.role !== "assistant") return blocks;
			if (message.error) return [...blocks.filter((block) => !(block.kind === "assistant" && block.streaming)), { kind: "note", seq, tone: "error", text: `The model could not answer: ${message.error}` }];
			const index = blocks.findLastIndex((block) => block.kind === "assistant" && block.streaming);
			const settled: Block = { kind: "assistant", seq, text: message.text, thinking: message.thinking, streaming: false };
			if (index !== -1) return blocks.with(index, { ...settled, seq: blocks[index]!.seq });
			return message.text || message.thinking ? [...blocks, settled] : blocks;
		}
		case "tool_start":
			return [...blocks, { kind: "tool", seq, id: payload.id, name: payload.name, args: payload.args, output: null, isError: false }];
		case "tool_end": {
			const index = blocks.findLastIndex((block) => block.kind === "tool" && block.id === payload.id);
			const done: Block = { kind: "tool", seq, id: payload.id, name: payload.name, args: null, output: payload.output, isError: payload.isError };
			return index === -1 ? [...blocks, done] : blocks.with(index, { ...(blocks[index] as Extract<Block, { kind: "tool" }>), output: payload.output, isError: payload.isError });
		}
		case "verify_started":
			return [...blocks, { kind: "verify", seq, command: payload.command, output: "" }];
		case "verify_output": {
			const index = blocks.findLastIndex((block) => block.kind === "verify");
			if (index === -1) return [...blocks, { kind: "verify", seq, command: "", output: payload.text }];
			const open = blocks[index] as Extract<Block, { kind: "verify" }>;
			return blocks.with(index, { ...open, output: open.output + payload.text });
		}
		case "exit":
			return [...blocks, { kind: "note", seq, text: `Session process exited (code ${payload.code}).` }];
		case "run_finished":
			return [...blocks, { kind: "note", seq, text: `Finished: ${String(payload.status).replace(/\.$/, "")}.` }];
		case "gap":
			return [...blocks, { kind: "note", seq, text: "Earlier output is no longer buffered." }];
		default:
			return blocks;
	}
}

/** One-line summary of a tool call for the collapsed row. */
export function describeTool(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	if (typeof a.path === "string") return `${name} ${shortenPath(a.path)}`;
	const detail = a.command ?? a.pattern ?? a.query;
	return typeof detail === "string" ? `${name} ${detail}` : name;
}

/** Keeps the end of a long path, which is the part that identifies the file. */
function shortenPath(path: string): string {
	const parts = path.split("/");
	return parts.length > 4 ? `…/${parts.slice(-3).join("/")}` : path;
}
