/**
 * SE-Bench: tower harness vs raw LLM vs basic loop, on local ollama models.
 *
 * Same task brief, same model, three amounts of scaffolding. No human anywhere: the tower arm's
 * human gates are decided by a script that rubber-stamps them. Scores six software-engineering
 * dimensions and renders spider charts. Resumable: every finished run lands in .state/state.json.
 */
import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensure16kVariant } from "./lib/ollama.ts";
import { TASKS, prepareStartDir, readBrief, type TaskDef } from "./lib/tasks.ts";
import type { ArmResult } from "./lib/types.ts";
import { runRawArm } from "./arms/raw.ts";
import { runBasicArm } from "./arms/basic.ts";
import { runPiArm } from "./arms/pi.ts";
import { TowerDaemon, runTowerArm } from "./tower/driver.ts";
import { scoreRun, DIMENSIONS, type Scored } from "./score.ts";
import { buildReport } from "./report.ts";
import { isRemoteModel, hasRemoteCredentials } from "./lib/openrouter.ts";

const BENCH = import.meta.dirname;
const STATE_DIR = join(BENCH, ".state");

export interface RunRecord {
	id: string;
	arm: "raw" | "basic" | "pi" | "tower";
	model: string;
	task: string;
	status: "done" | "failed";
	startedAt: number;
	endedAt: number;
	result: ArmResult | null;
	score: Scored | null;
	error?: string;
}

interface State {
	runs: Record<string, RunRecord>;
}

const statePath = join(STATE_DIR, "state.json");

async function loadState(): Promise<State> {
	try {
		return JSON.parse(await readFile(statePath, "utf8")) as State;
	} catch {
		return { runs: {} };
	}
}

async function saveState(state: State): Promise<void> {
	await mkdir(STATE_DIR, { recursive: true });
	await writeFile(statePath, JSON.stringify(state, null, 2));
}

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		if (arg.includes("=")) {
			const [key, ...rest] = arg.slice(2).split("=");
			args[key] = rest.join("=");
		} else {
			args[arg.slice(2)] = argv[i + 1]?.startsWith("--") ? "true" : (argv[i + 1] ?? "true");
		}
	}
	return args;
}

function logFile(name: string): (line: string) => void {
	mkdirSync(join(STATE_DIR, "logs"), { recursive: true });
	const path = join(STATE_DIR, "logs", `${name}.log`);
	return (line: string) => {
		const stamped = `${new Date().toISOString()} ${line}`;
		console.log(`[${name}] ${line}`);
		appendFileSync(path, `${stamped}\n`);
	};
}

const MODELS = ["qwen2.5-coder:7b", "llama3.1:8b"];
const ARMS = ["raw", "basic", "pi", "tower"] as const;
type Arm = (typeof ARMS)[number];

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	// One runner at a time: concurrent runs would collide on the daemon port, ollama, and state.json.
	try {
		if (existsSync(join(STATE_DIR, "lock"))) throw new Error("another se-bench run is active (delete .state/lock if that is wrong)");
		await mkdir(STATE_DIR, { recursive: true });
		await writeFile(join(STATE_DIR, "lock"), String(process.pid));
	} catch (error) {
		if (String((error as Error).message).includes("another se-bench")) throw error;
	}
	try {
		await runBenchmark(args);
	} finally {
		await rm(join(STATE_DIR, "lock"), { force: true });
	}
}

async function runBenchmark(args: Record<string, string>): Promise<void> {
	const smoke = args.smoke === "true";
	const models = (args.models ?? (smoke ? "qwen2.5-coder:7b" : MODELS.join(","))).split(",").filter(Boolean);
	const tasks = (args.tasks ?? (smoke ? "sluglib" : TASKS.map((t) => t.id).join(","))).split(",").filter(Boolean);
	const arms = (args.arms ?? ARMS.join(",")).split(",") as Arm[];
	const basicDeadline = Number(args["basic-minutes"] ?? (smoke ? 10 : 35)) * 60_000;
	const piDeadline = Number(args["pi-minutes"] ?? (smoke ? 10 : 35)) * 60_000;
	const towerDeadline = Number(args["tower-minutes"] ?? (smoke ? 30 : 90)) * 60_000;

	if (args.only === "report") {
		const state = await loadState();
		await buildReport(state.runs, join(BENCH, "report.html"), { judgeModel: args.judge ?? "?" });
		console.log(`report written to ${join(BENCH, "report.html")}`);
		return;
	}

	const remote = models.some(isRemoteModel);
	if (remote && !hasRemoteCredentials()) throw new Error("remote OpenRouter models requested but OPENROUTER_API_KEY is not set");
	if (remote && arms.some((a) => a === "raw" || a === "basic")) {
		throw new Error("the raw/basic arms are ollama-only — run them with a local model (or use --arms=pi,tower for a remote model)");
	}
	// Judge: explicit --judge wins; otherwise the same remote model judges remote runs (one strong
	// judge, shared bias), local runs keep the local qwen judge.
	const judgeModel = args.judge ?? (remote ? models.find(isRemoteModel)! : await ensure16kVariant("qwen2.5-coder:7b"));
	for (const model of models) if (!isRemoteModel(model)) await ensure16kVariant(model);

	const state = await loadState();
	const taskDefs = tasks.map((id) => TASKS.find((t) => t.id === id)).filter((t): t is TaskDef => Boolean(t));

	for (const model of models) {
		const model16k = isRemoteModel(model) ? model : await ensure16kVariant(model);
		for (const task of taskDefs) {
			for (const arm of arms) {
				const id = `${arm}:${model}:${task.id}`;
				if (state.runs[id]?.status === "done") {
					console.log(`skip ${id} (done)`);
					continue;
				}
				const log = logFile(`${arm}-${model.replace(/[^a-z0-9.]+/gi, "-")}-${task.id}`);
				const runDir = join(STATE_DIR, "runs", `${arm}-${model.replace(/[^a-z0-9.]+/gi, "-")}-${task.id}`);
				await mkdir(runDir, { recursive: true });
				const record: RunRecord = { id, arm, model, task: task.id, status: "done", startedAt: Date.now(), endedAt: 0, result: null, score: null };
				log(`=== ${arm} / ${model} / ${task.id} ===`);
				try {
					let result: ArmResult;
					let outDir: string;
					if (arm === "raw") {
						outDir = await prepareStartDir(task.id, join(runDir, "out"));
						result = await runRawArm(task.id, outDir, model16k);
					} else if (arm === "basic") {
						outDir = await prepareStartDir(task.id, join(runDir, "out"));
						result = await runBasicArm(task, outDir, model16k, basicDeadline, (line) => log(line));
					} else if (arm === "pi") {
						outDir = await prepareStartDir(task.id, join(runDir, "out"));
						result = await runPiArm(task, outDir, model16k, piDeadline, (line) => log(line));
					} else {
						const benchDir = join(runDir, "bench");
						await mkdir(benchDir, { recursive: true });
						const daemon = new TowerDaemon(benchDir, 4799, (line) => log(line));
						await daemon.prepare(model16k);
						await daemon.start();
						try {
							result = await runTowerArm(task, benchDir, daemon, (line) => log(line), towerDeadline);
						} finally {
							await daemon.stop();
						}
					}
					record.result = result;
					log(`arm finished: ${result.notes.join("; ")}`);
					record.score = await scoreRun(task, await readBrief(task.id), result.outDir, judgeModel);
					log(`scored: ${JSON.stringify(record.score.dimensions)}`);
				} catch (error) {
					record.status = "failed";
					record.error = error instanceof Error ? error.message : String(error);
					log(`FAILED: ${record.error}`);
				}
				record.endedAt = Date.now();
				state.runs[id] = record;
				await saveState(state);
			}
		}
	}

	await buildReport(state.runs, join(BENCH, "report.html"), { judgeModel });
	console.log(`\nreport: ${join(BENCH, "report.html")}`);
}

await main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
