/** Cell audit: lists every expected matrix cell, its status, and flags judge parse failures. */
import { readFile } from "node:fs/promises";
import { TASKS } from "./lib/tasks.ts";

const MODEL = process.argv[2] ?? "openrouter/cohere/north-mini-code:free";
const ARMS = ["pi", "tower"];

const state = JSON.parse(await readFile(new URL("./.state/state.json", import.meta.url), "utf8"));
let bad = 0;
for (const task of TASKS.map((t) => t.id)) {
	for (const arm of ARMS) {
		const id = `${arm}:${MODEL}:${task}`;
		const r = state.runs[id];
		if (!r) {
			console.log(`MISSING  ${id}`);
			bad++;
			continue;
		}
		const parse = r.score?.judgeRationale && "parse" in r.score.judgeRationale ? ` JUDGE-PARSE-FAIL: ${r.score.judgeRationale.parse.slice(0, 80)}` : "";
		console.log(`${r.status.padEnd(6)}  ${id}${parse}`);
		if (parse) bad++;
		if (r.status === "failed") console.log(`         error: ${(r.error ?? "").slice(0, 140)}`);
	}
}
console.log(bad === 0 ? "\nall cells present, no judge parse failures" : `\n${bad} problem(s)`);
