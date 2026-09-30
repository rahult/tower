/**
 * The Tower arm: the same task, the same model, driven through Tower's full pipeline —
 * planning with its coach, the plan gate, building against a verify gate, the testing stage,
 * shipped review flows, the feedback gate, local merge. A script plays the person: it approves
 * gates, answers questions with a generic "use your judgement", and retries stuck builds,
 * so the comparison carries no human advantage.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cpSync } from "node:fs";
import { run as shell } from "../lib/shell.ts";
import { readBrief, type TaskDef } from "../lib/tasks.ts";
import type { ArmResult } from "../lib/types.ts";
import { isRemoteModel, remoteModelId } from "../lib/openrouter.ts";
import { startOpenRouterProxy, type RetryProxyHandle } from "../lib/openrouter-proxy.ts";
import { startProxy, type ProxyHandle } from "./ollama-proxy.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

interface Card {
	id: string;
	projectId: string;
	stage: string;
	status: string;
	worktreePath: string | null;
	needsAttentionReason: string | null;
}
interface Gate {
	id: string;
	kind: string;
	status: "pending" | "approved" | "rejected";
}
interface StageRun {
	id: string;
	kind: string;
	stage: string;
	status: string;
	resultStatus: string | null;
	resultSummary: string | null;
	questions: Array<{ question: string; options: string[] }> | null;
	tokens: { total: number } | null;
}
interface CardDetail {
	card: Card;
	runs: StageRun[];
	gates: Gate[];
}

export class TowerDaemon {
	private child: ChildProcess | null = null;
	private proxy: ProxyHandle | null = null;
	private remoteProxy: RetryProxyHandle | null = null;
	private model16k = "";
	private readonly log: (line: string) => void;
	readonly benchDir: string;
	readonly port: number;

	constructor(benchDir: string, port: number, log: (line: string) => void) {
		this.benchDir = benchDir;
		this.port = port;
		this.log = log;
	}

	get base(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Private pi config (models.json pointed at the tool-call proxy, or directly at OpenRouter) + private TOWER_HOME with the stage-model override. */
	async prepare(model16k: string): Promise<void> {
		this.model16k = model16k;
		const piDir = join(this.benchDir, ".pi-agent");
		await mkdir(piDir, { recursive: true });
		const home = join(this.benchDir, ".tower");
		await mkdir(home, { recursive: true });
		if (isRemoteModel(model16k)) {
			// Free OpenRouter tier throttles hard; the local retry proxy keeps pi's print-mode run
			// alive through 429/5xx storms (same role the ollama tool-call proxy plays for locals).
			this.remoteProxy = await startOpenRouterProxy(this.port + 1, (line) => this.log(line));
			await writeFile(
				join(piDir, "models.json"),
				JSON.stringify(
					{
						providers: {
							openrouter: {
								baseUrl: `http://127.0.0.1:${this.remoteProxy.port}/v1`,
								api: "openai-completions",
								apiKey: "openrouter",
								models: [{ id: remoteModelId(model16k) }],
							},
						},
					},
					null,
					2,
				),
			);
			const stageModel = { model: model16k, thinking: "off" };
			await writeFile(join(home, "config.json"), `${JSON.stringify({ models: { planning: stageModel, building: stageModel, testing: stageModel } }, null, 2)}\n`);
			return;
		}
		const proxyPort = this.port + 1;
		await writeFile(
			join(piDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						ollama: {
							baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
							api: "openai-completions",
							apiKey: "ollama",
							compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
							models: [{ id: model16k }],
						},
					},
				},
				null,
				2,
			),
		);
		const stageModel = { model: `ollama/${model16k}`, thinking: "off" };
		await writeFile(join(home, "config.json"), `${JSON.stringify({ models: { planning: stageModel, building: stageModel, testing: stageModel } }, null, 2)}\n`);
	}

	async start(): Promise<void> {
		if (!isRemoteModel(this.model16k)) this.proxy = await startProxy([this.model16k], this.port + 1);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			TOWER_HOME: join(this.benchDir, ".tower"),
			TOWER_PORT: String(this.port),
			PI_CODING_AGENT_DIR: join(this.benchDir, ".pi-agent"),
			TOWER_ISSUES_POLL_MS: "0",
			TOWER_MAX_CONCURRENT: "1",
			TOWER_INVARIANT_SIMULATION: process.env.BENCH_TOWER_INVARIANT ?? "",
		};
		this.child = spawn(process.execPath, [join(REPO_ROOT, "packages", "daemon", "src", "main.ts")], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
		this.child.stdout?.on("data", (chunk) => this.log(`[daemon] ${chunk}`));
		this.child.stderr?.on("data", (chunk) => this.log(`[daemon:err] ${chunk}`));
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const health = await fetch(`${this.base}/api/health`, { signal: AbortSignal.timeout(1_000) });
				if (health.ok) return;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		throw new Error("daemon did not become healthy in 60s");
	}

	async stop(): Promise<void> {
		if (this.remoteProxy) {
			await this.remoteProxy.stop();
			this.remoteProxy = null;
		}
		if (this.proxy) {
			await this.proxy.stop();
			this.proxy = null;
		}
		if (!this.child) return;
		const child = this.child;
		this.child = null;
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				resolve();
			}, 5_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	async api<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${this.base}${path}`, {
			method,
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		let json: unknown = null;
		try {
			json = JSON.parse(text);
		} catch {
			json = text;
		}
		if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 400)}`);
		return json as T;
	}
}

/** Copies a produced tree (repo main, or a card worktree) without git noise. */
export function snapshot(source: string | null, target: string): boolean {
	if (!source || !existsSync(source)) return false;
	cpSync(source, target, { recursive: true, filter: (src) => !/(^|\/)\.git($|\/)/.test(src) && !/(^|\/)node_modules($|\/)/.test(src) });
	return true;
}

/**
 * What the simulated person says when a stage stops to ask. Deliberately directive on the one
 * policy every brief already states (no new dependencies — built-ins only, which also answers
 * the classic "may I add a package?" block), and default-standard otherwise.
 */
const ANSWER = "Follow the brief: no new dependencies — implement with Node.js built-ins only. For anything else, take the standard approach that best matches the brief.";

const RETRY_FEEDBACK = "Keep going, following the brief exactly: no new dependencies (Node.js built-ins only), finish the remaining work, and make the tests pass.";

export async function runTowerArm(
	task: TaskDef,
	benchDir: string,
	daemon: TowerDaemon,
	log: (line: string) => void,
	deadlineMs: number,
): Promise<ArmResult> {
	const started = Date.now();
	const brief = await readBrief(task.id);

	// A dedicated repo per run, so the local merge at the end is clean.
	const repoPath = join(benchDir, "repos", `${task.id}-${started}`);
	await shell("mkdir", ["-p", repoPath], benchDir);
	const { prepareRepo } = await import("../lib/tasks.ts");
	await prepareRepo(task.id, repoPath);

	const project = await daemon.api<{ id: string }>("POST", "/api/projects", { repoPath, name: `bench-${task.id}-${started}` });
	await daemon.api("PATCH", `/api/projects/${project.id}`, { testCommand: "npm test", verifyCommand: "npm test", parallelReviews: true });
	const card = await daemon.api<Card>("POST", "/api/cards", { projectId: project.id, title: task.title, brief });
	await daemon.api("POST", `/api/cards/${card.id}/enqueue`);
	log(`card ${card.id} enqueued`);

	const gatesDecided: string[] = [];
	const attention: string[] = [];
	let answers = 0;
	let retries = 0;
	const MAX_RETRIES = 5;
	const POLL_MS = 5_000;
	let endStage = "unknown";
	let endStatus = "unknown";
	let settled = false;

	while (!settled && Date.now() - started < deadlineMs) {
		await new Promise((r) => setTimeout(r, POLL_MS));
		let detail: CardDetail;
		try {
			detail = await daemon.api<CardDetail>("GET", `/api/cards/${card.id}`);
		} catch (error) {
			log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		endStage = detail.card.stage;
		endStatus = detail.card.status;

		// Open human gates: the script is the person. Approve everything, acknowledging blocking reviews.
		for (const gate of detail.gates) {
			if (gate.status !== "pending") continue;
			log(`gate ${gate.kind} -> approve`);
			gatesDecided.push(gate.kind);
			await daemon.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve", acknowledgeBlocking: true });
		}

		// A stage that stopped to ask: answer generically, like a hands-off person would.
		if (detail.card.status === "awaiting_input") {
			const asking = detail.runs.filter((run) => run.questions && run.questions.length > 0).at(-1);
			if (asking) {
				const payload = asking.questions!.map((q) => ({ question: q.question, answer: ANSWER }));
				log(`answering ${payload.length} question(s) from ${asking.id}`);
				try {
					answers += payload.length;
					await daemon.api("POST", `/api/cards/${card.id}/answers`, { answers: payload });
				} catch (error) {
					log(`answers rejected: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}

		if (detail.card.status === "needs_attention") {
			const reason = detail.card.needsAttentionReason ?? "unspecified";
			if (retries < MAX_RETRIES) {
				retries += 1;
				attention.push(reason);
				log(`needs attention (${reason}) -> retry ${retries}/${MAX_RETRIES}`);
				try {
					await daemon.api("POST", `/api/cards/${card.id}/retry`, { feedback: RETRY_FEEDBACK });
				} catch (error) {
					log(`retry rejected: ${error instanceof Error ? error.message : String(error)}`);
				}
			} else {
				attention.push(`gave up after ${MAX_RETRIES} retries: ${reason}`);
				log(`giving up: ${reason}`);
				await daemon.api("POST", `/api/cards/${card.id}/abort`).catch(() => {});
				settled = true;
			}
		}

		if (detail.card.stage === "done" || detail.card.status === "abandoned") {
			settled = true;
		}
	}
	if (!settled) {
		attention.push("deadline reached");
		log("deadline reached; aborting card");
		await daemon.api("POST", `/api/cards/${card.id}/abort`).catch(() => {});
	}

	const detail = await daemon.api<CardDetail>("GET", `/api/cards/${card.id}`).catch(() => null);
	const tokens = (detail?.runs ?? []).reduce((sum, run) => sum + (run.tokens?.total ?? 0), 0);

	// Score the merged main when the card finished; otherwise whatever the worktree holds.
	const outDir = join(benchDir, "prod", `${task.id}-${started}`);
	const merged = snapshot(repoPath, outDir);
	if (!merged && detail?.card.worktreePath) snapshot(detail.card.worktreePath, outDir);

	return {
		outDir,
		usage: { promptTokens: 0, outputTokens: 0, llmCalls: 0, wallMs: Date.now() - started, towerTokens: tokens },
		notes: [`end stage ${endStage} / status ${endStatus}`],
		tower: { cardId: card.id, projectId: project.id, endStage, endStatus, gatesDecided, answers, retries, attention },
	};
}
