/** The raw arm: one chat completion, no tools, no retries. Whatever comes back is the work. */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chat } from "../lib/ollama.ts";
import { readBrief } from "../lib/tasks.ts";
import type { ArmResult } from "../lib/types.ts";

const FORMAT_INSTRUCTIONS = `

Respond with the complete contents of every file the project needs. For each file, emit first a line of the form

FILE: <relative/path>

immediately followed by one fenced code block containing that file's full contents. Emit every file, including tests and README. Do not omit any file. Do not add commentary outside the FILE: blocks.`;

/** Extracts FILE: <path> + fenced-block pairs; falls back to fenced blocks with a path-like info string. */
export function parseFileBlocks(text: string): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];
	const pattern = /FILE:\s*([^\n`]+)\n+```[^\n]*\n([\s\S]*?)```/g;
	for (const match of text.matchAll(pattern)) {
		const path = match[1].trim().replace(/^["'`]|["'`]$/g, "");
		if (path) files.push({ path, content: match[2] });
	}
	if (files.length > 0) return files;
	const fallback = /```[a-z0-9]*\s*(?:\/\/|#)?\s*([\w./-]+\.[a-z]+)?[^\n]*\n([\s\S]*?)```/gi;
	for (const match of text.matchAll(fallback)) {
		if (match[1]) files.push({ path: match[1].trim(), content: match[2] });
	}
	return files;
}

export async function runRawArm(taskId: string, outDir: string, model: string): Promise<ArmResult> {
	const started = Date.now();
	const briefText = await readBrief(taskId);
	const result = await chat({
		model,
		messages: [
			{ role: "system", content: "You are an expert software engineer. You produce complete, correct, well-tested implementations." },
			{ role: "user", content: briefText + FORMAT_INSTRUCTIONS },
		],
		numCtx: 16384,
		timeoutMs: 900_000,
	});
	const files = parseFileBlocks(result.content);
	const notes: string[] = [];
	if (files.length === 0) notes.push("no parseable FILE: blocks in the response");
	for (const file of files) {
		const target = join(outDir, file.path);
		if (!target.startsWith(outDir)) {
			notes.push(`skipped unsafe path ${file.path}`);
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.content);
	}
	notes.push(`${files.length} file(s) written from the response`);
	return {
		outDir,
		usage: { promptTokens: result.usage.promptTokens, outputTokens: result.usage.outputTokens, llmCalls: 1, wallMs: Date.now() - started },
		notes,
	};
}
