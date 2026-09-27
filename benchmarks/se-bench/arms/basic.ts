/**
 * The basic arm: a minimal single-agent tool loop. It has the same tools and the same time a
 * no-frills coding loop gets — no plan gate, no review, no test enforcement. This is the
 * "harness without the discipline" baseline.
 */
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { chat, type ChatMessage, type ToolSpec } from "../lib/ollama.ts";
import { readBrief } from "../lib/tasks.ts";
import { listFiles, type TaskDef } from "../lib/tasks.ts";
import { runShellLine } from "../lib/shell.ts";
import type { ArmResult } from "../lib/types.ts";

const TOOLS: ToolSpec[] = [
	{
		type: "function",
		function: {
			name: "write_file",
			description: "Write (or overwrite) a file with the given content. Creates parent directories.",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "relative path" }, content: { type: "string" } },
				required: ["path", "content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a file's contents.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	},
	{
		type: "function",
		function: {
			name: "list_files",
			description: "List all files in the working directory.",
			parameters: { type: "object", properties: {}, required: [] },
		},
	},
	{
		type: "function",
		function: {
			name: "run_command",
			description: "Run a shell command in the working directory and see its output (max ~90s).",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		},
	},
	{
		type: "function",
		function: {
			name: "finish",
			description: "Call when the work is complete. Summarise what you built.",
			parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
		},
	},
];

const MAX_STEPS = 48;
const MAX_TOOL_OUTPUT = 4_000;

/**
 * ollama's native tool_calls field is unreliable for several local models (qwen2.5-coder emits the
 * call as JSON text in content), so recover calls from the text: <tool_call> tags, fenced blocks,
 * or bare `{"name": …, "arguments": …}` objects.
 */
export function parseInlineToolCalls(content: string): Array<{ function: { name: string; arguments: Record<string, unknown> } }> {
	const calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
	const candidates: string[] = [];
	const tagged = content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g);
	for (const match of tagged) candidates.push(match[1]);
	if (candidates.length === 0) {
		const fenced = content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
		for (const match of fenced) candidates.push(match[1]);
	}
	if (candidates.length === 0 && content.trimStart().startsWith("{")) candidates.push(content);
	const tryParse = (text: string) => {
		try {
			const parsed = JSON.parse(text.trim());
			return Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			return null;
		}
	};
	for (const candidate of candidates) {
		const parsed = tryParse(candidate);
		if (parsed) {
			for (const item of parsed) if (item && typeof item.name === "string") calls.push({ function: { name: item.name, arguments: item.arguments ?? item.parameters ?? {} } });
			continue;
		}
		// Balanced-brace scan for concatenated objects.
		for (let i = candidate.indexOf("{"); i !== -1; i = candidate.indexOf("{", i + 1)) {
			let depth = 0;
			let inString = false;
			let escaped = false;
			for (let j = i; j < candidate.length; j++) {
				const ch = candidate[j];
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = !inString;
				else if (!inString && ch === "{") depth++;
				else if (!inString && ch === "}") {
					depth--;
					if (depth === 0) {
						const parsed = tryParse(candidate.slice(i, j + 1));
						if (parsed) for (const item of parsed) if (item && typeof item.name === "string") calls.push({ function: { name: item.name, arguments: item.arguments ?? item.parameters ?? {} } });
						i = j;
						break;
					}
				}
			}
		}
	}
	return calls;
}

/**
 * Fallback for models that answer a big spec in markdown instead of using tools: treat fenced
 * code blocks as file writes, taking the target path from the nearest path-like token above
 * the fence (a heading or backticked name). Returns [] when nothing path-like is found.
 */
export function extractMarkdownFiles(content: string): Array<{ path: string; content: string }> {
	const out: Array<{ path: string; content: string }> = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!/^```/.test(lines[i])) continue;
		const close = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l));
		if (close === -1) break;
		const body = lines.slice(i + 1, close).join("\n");
		for (let back = i - 1; back >= Math.max(0, i - 3); back--) {
			const candidate = [...lines[back].matchAll(/`([^`]+\.[a-z]+)`/g), ...lines[back].matchAll(/(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.[a-z]{1,4})\s*:?\s*$/g)]
				.map((m) => m[1])
				.find((p) => !/\.(md|txt)$/i.test(p) || /src|test|lib|bin/.test(p));
			if (candidate) {
				out.push({ path: candidate.replace(/^["'`]|["'`]$/g, ""), content: `${body}\n` });
				break;
			}
		}
		i = close;
	}
	return out;
}

const resolveIn = (outDir: string, rel: string): string => {
	const full = normalize(join(outDir, rel));
	if (!full.startsWith(normalize(outDir) + sep) && full !== normalize(outDir)) throw new Error(`path must stay inside the working directory: ${rel}`);
	return full;
};

const SYSTEM = `You are a coding agent working alone in a project directory that already contains package.json, an empty src/ and an empty test/ folder. Implement the user's specification there: complete and correct behaviour, clean modular code, real tests in test/, and a README. Run the tests yourself (npm test) and fix failures before finishing.

Act ONLY through tools. Every one of your replies must consist solely of tool calls — one or more JSON objects, each {"name": "write_file" | "read_file" | "list_files" | "run_command" | "finish", "arguments": { ... }}. Never write code in your reply text, never use markdown: files must be created with write_file, commands must run with run_command. When the tests pass and the work is complete, call finish.`;

const NUDGE = "Reply with tool calls only — one JSON object per line, each of the form {\"name\": …, \"arguments\": …}. Do the next concrete step now (usually write_file for the next module or test, or run_command \"npm test\").";

export async function runBasicArm(task: TaskDef, outDir: string, model: string, deadlineMs: number, log?: (line: string) => void): Promise<ArmResult> {
	const started = Date.now();
	const brief = await readBrief(task.id);
	const messages: ChatMessage[] = [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: `Specification:\n\n${brief}` },
	];
	const usage = { promptTokens: 0, outputTokens: 0, llmCalls: 0 };
	const notes: string[] = [];
	let finished = false;

	for (let step = 0; step < MAX_STEPS && !finished; step++) {
		if (Date.now() - started > deadlineMs) {
			notes.push(`stopped at step ${step}: deadline`);
			break;
		}
		// One slow/hung reply must not kill the run: give each step a second attempt.
		let result = null as Awaited<ReturnType<typeof chat>> | null;
		for (let attempt = 0; attempt < 2 && !result; attempt++) {
			try {
				result = await chat({ model, messages, tools: TOOLS, numCtx: 16384, temperature: 0.2, timeoutMs: 300_000 });
			} catch (error) {
				log?.(`step ${step} attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
				if (Date.now() - started > deadlineMs) break;
			}
		}
		if (!result) {
			notes.push(`stopped at step ${step}: chat failed twice`);
			break;
		}
		usage.promptTokens += result.usage.promptTokens;
		usage.outputTokens += result.usage.outputTokens;
		usage.llmCalls += 1;

		const calls = result.toolCalls.length > 0 ? result.toolCalls : parseInlineToolCalls(result.content);
		log?.(`step ${step}: ${calls.length > 0 ? calls.map((c) => c.function.name).join(",") : `prose (${result.content.length}b)`}`);
		if (calls.length === 0) {
			// The model answered in prose: apply any markdown file blocks it produced, else nudge.
			const markdownFiles = extractMarkdownFiles(result.content);
			if (markdownFiles.length > 0) {
				const written: string[] = [];
				for (const file of markdownFiles) {
					try {
						const target = resolveIn(outDir, file.path);
						await mkdir(dirname(target), { recursive: true });
						await writeFile(target, file.content);
						written.push(file.path);
					} catch {
						notes.push(`skipped unsafe path ${file.path}`);
					}
				}
				messages.push({ role: "assistant", content: result.content });
				messages.push({
					role: "user",
					content: written.length
						? `I wrote your code blocks to ${written.join(", ")}. From here, act with tools only: reply with JSON tool calls ({\"name\": …, \"arguments\": …}). Next step: run_command \"npm test\" to check, fix whatever fails, and call finish when green.`
						: NUDGE,
				});
				notes.push(`markdown fallback wrote ${written.join(", ")}`);
				continue;
			}
			// Nothing actionable: nudge the loop back onto tools; three bare replies end it.
			if (notes.filter((n) => n.includes("no tool call")).length >= 2) {
				notes.push("ended: model replied without tool calls");
				break;
			}
			messages.push({ role: "assistant", content: result.content });
			messages.push({ role: "user", content: NUDGE });
			notes.push(`no tool call; nudged (content head: ${result.content.slice(0, 80).replace(/\n/g, " ")})`);
			continue;
		}
		messages.push({ role: "assistant", content: result.content || "", ...(calls.length ? { tool_calls: calls } : {}) });
		const outputs: ChatMessage[] = [];
		for (const call of calls) {
			const name = call.function.name;
			let output: string;
			try {
				const args = call.function.arguments ?? {};
				if (name === "write_file") {
					const target = resolveIn(outDir, String(args.path));
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, String(args.content ?? ""));
					output = `wrote ${args.path} (${String(args.content ?? "").length} bytes)`;
				} else if (name === "read_file") {
					const target = resolveIn(outDir, String(args.path));
					output = (await readFile(target, "utf8")).slice(0, MAX_TOOL_OUTPUT);
					if ((await stat(target)).size > MAX_TOOL_OUTPUT) output += "\n… [truncated]";
				} else if (name === "list_files") {
					output = (await listFiles(outDir)).join("\n") || "(empty)";
				} else if (name === "run_command") {
					const proc = await runShellLine(String(args.command ?? ""), outDir, 90_000);
					const text = `$ ${args.command}\n${proc.stdout}\n${proc.stderr}`.trim();
					output = `${text.slice(0, MAX_TOOL_OUTPUT)}${text.length > MAX_TOOL_OUTPUT ? "\n… [truncated]" : ""}\n(exit ${proc.code})`;
				} else if (name === "finish") {
					output = "finished";
					finished = true;
				} else {
					output = `unknown tool ${name}`;
				}
			} catch (error) {
				output = `error: ${error instanceof Error ? error.message : String(error)}`;
			}
			outputs.push({ role: "tool", content: output, name });
		}
		messages.push(...outputs);
		elideOldToolOutputs(messages);
	}
	if (!finished && !notes.some((n) => n.includes("ended"))) notes.push("stopped: step budget");
	return {
		outDir,
		usage: { ...usage, wallMs: Date.now() - started },
		notes,
	};
}

/** Keeps the transcript within budget: tool results older than the last 6 messages lose their payload. */
function elideOldToolOutputs(messages: ChatMessage[]): void {
	let remaining = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		remaining--;
		if (remaining >= 6 && messages[i].role === "tool" && messages[i].content.length > 200) {
			messages[i] = { ...messages[i], content: `${messages[i].content.slice(0, 160)}\n… [older output elided]` };
		}
	}
}
