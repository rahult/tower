/** Re-judge one completed cell in place: reuses the arm's outDir, re-runs only scoreRun. */
import { readFile, writeFile } from "node:fs/promises";
import { TASKS, readBrief } from "./lib/tasks.ts";
import { scoreRun } from "./score.ts";

const id = process.argv[2];
const judgeOverride = process.argv[3]; // optional --judge model
if (!id) throw new Error("usage: node re-judge.ts <arm:model:task> [judgeModel]");

const statePath = new URL("./.state/state.json", import.meta.url);
const state = JSON.parse(await readFile(statePath, "utf8"));
const record = state.runs[id];
if (!record) throw new Error(`no such cell: ${id}`);
if (!record.result?.outDir) throw new Error("cell has no outDir to score");

const task = TASKS.find((t) => t.id === record.task)!;
const judgeModel = judgeOverride ?? record.model;
console.log(`re-judging ${id} (outDir ${record.result.outDir}) with ${judgeModel}`);
record.score = await scoreRun(task, await readBrief(task.id), record.result.outDir, judgeModel);
console.log("scored:", JSON.stringify(record.score.dimensions));
if (record.score.judgeRationale && "parse" in record.score.judgeRationale) {
	console.error("WARNING judge parse failure:", record.score.judgeRationale.parse.slice(0, 200));
}
await writeFile(statePath, JSON.stringify(state, null, 2));
console.log("state updated");
