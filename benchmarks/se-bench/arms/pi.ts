/**
 * The pi arm: stock `pi -p` — the agent harness Tower is built on, run exactly as a user would
 * run it. Default coding system prompt, default tool set, no Tower scaffolding, no gates, no
 * reviews. Same brief, same model, same deadline discipline as the other arms: when the deadline
 * hits, the process is killed and whatever is on disk is what gets scored.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readBrief, type TaskDef } from "../lib/tasks.ts";
import { isRemoteModel, remoteModelId } from "../lib/openrouter.ts";
import { startOpenRouterProxy, type RetryProxyHandle } from "../lib/openrouter-proxy.ts";
import type { ArmResult } from "../lib/types.ts";

/**
 * Runs pi headless in `outDir`. Full pi output is saved next to the output dir (pi-output.log);
 * `log` gets a trimmed live tail.
 */
export async function runPiArm(task: TaskDef, outDir: string, model: string, deadlineMs: number, log?: (line: string) => void): Promise<ArmResult> {
	const started = Date.now();
	const brief = await readBrief(task.id);
	const outputPath = join(dirname(outDir), "pi-output.log");
	const output = createWriteStream(outputPath);
	const notes: string[] = [];

	// Stock pi: no custom system prompt, no allowlisted tools, user config as found. --thinking off
	// matches the tower arm's stage config; --no-session keeps the run ephemeral. Remote models go
	// through a local retry proxy (PI_CODING_AGENT_DIR models.json) — the prompts, tools, and pi
	// itself are untouched; only the endpoint changes, so free-tier throttles don't kill the run.
	let proxy: RetryProxyHandle | null = null;
	let env = { ...process.env };
	if (isRemoteModel(model)) {
		proxy = await startOpenRouterProxy(4811, (line) => log?.(`[proxy] ${line}`));
		const piDir = join(dirname(outDir), ".pi-agent");
		await mkdir(piDir, { recursive: true });
		await writeFile(
			join(piDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						openrouter: {
							baseUrl: `http://127.0.0.1:${proxy.port}/v1`,
							api: "openai-completions",
							apiKey: "openrouter",
							models: [{ id: remoteModelId(model) }],
						},
					},
				},
				null,
				2,
			),
		);
		env.PI_CODING_AGENT_DIR = piDir;
	}
	const args = ["-p", "--provider", "openrouter", "--model", remoteModelId(model), "--thinking", "off", "--no-session", "--", brief];
	log?.(`spawning: pi ${args.slice(0, -1).join(" ")} "<brief>"`);
	const child = spawn("pi", args, { cwd: outDir, env, stdio: ["ignore", "pipe", "pipe"] });
	let tail = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output.write(chunk);
		tail = (tail + chunk.toString()).slice(-400);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output.write(chunk);
		tail = (tail + chunk.toString()).slice(-400);
	});

	const finished = await new Promise<{ code: number | null; killed: boolean }>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			notes.push("deadline reached: SIGTERM");
			log?.("deadline reached; killing pi");
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!settled) child.kill("SIGKILL");
			}, 10_000).unref();
		}, deadlineMs);
		child.once("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, killed: Date.now() - started >= deadlineMs });
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			notes.push(`spawn failed: ${error.message}`);
			resolve({ code: 1, killed: false });
		});
	});
	output.end();
	await proxy?.stop();

	const files = await readFile(join(outDir, "package.json"), "utf8").then(() => true, () => false);
	if (finished.killed) notes.push(`pi killed at deadline (exit ${finished.code})`);
	else if (finished.code === 0) notes.push("pi exited cleanly");
	else notes.push(`pi exited with code ${finished.code}`);
	if (!files) notes.push("warning: no package.json in output dir");
	notes.push(`pi output tail: ${tail.slice(-160).replace(/\s+/g, " ")}`);

	return {
		outDir,
		usage: { promptTokens: 0, outputTokens: 0, llmCalls: 0, wallMs: Date.now() - started },
		notes,
	};
}
