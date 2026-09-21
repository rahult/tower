/**
 * M0 spike (throwaway): prove pi can be driven from an external project via RpcClient.
 *
 * Run: node spikes/rpc-spike.ts
 * Env: TC_SPIKE_MODEL (default zai/glm-5.3), TC_SPIKE_ALT_MODEL (default anthropic/claude-haiku-4-5)
 *
 * Prints a pass/fail checklist and records the raw event stream as a fixture
 * for the daemon's FakeSessionDriver.
 */
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const MODEL = process.env.TC_SPIKE_MODEL ?? "zai/glm-5.3";
const ALT_MODEL = process.env.TC_SPIKE_ALT_MODEL ?? "anthropic/claude-haiku-4-5";
const STAGE_TIMEOUT_MS = 5 * 60_000;

const here = dirname(fileURLToPath(import.meta.url));
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const cliPath = join(dirname(piEntry), "cli.js");

type AnyEvent = { type: string; [key: string]: unknown };
type UiResponse = { type: "extension_ui_response"; id: string; confirmed?: boolean; value?: string; cancelled?: boolean };

/** RpcClient cannot answer extension_ui_request through its public API; write to the child's stdin directly. */
class PiClient extends RpcClient {
	private child(): ChildProcess | null {
		return (this as unknown as { process: ChildProcess | null }).process;
	}
	respondToUi(response: UiResponse): void {
		this.child()?.stdin?.write(`${JSON.stringify(response)}\n`);
	}
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** One permanent subscription; settled() resolves on the next agent_settled. */
function track(client: PiClient, log: AnyEvent[]) {
	const seen: AnyEvent[] = [];
	let waiters: Array<() => void> = [];
	const listeners: Array<(e: AnyEvent) => void> = [];
	client.onEvent((raw) => {
		const event = raw as unknown as AnyEvent;
		seen.push(event);
		log.push(event);
		for (const listener of listeners) listener(event);
		if (event.type === "agent_settled") {
			const current = waiters;
			waiters = [];
			for (const resolve of current) resolve();
		}
	});
	return {
		seen,
		on: (listener: (e: AnyEvent) => void) => listeners.push(listener),
		settled: () =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timed out waiting for agent_settled")), STAGE_TIMEOUT_MS);
				waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			}),
	};
}

function env(): Record<string, string> {
	return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
}

async function main(): Promise<void> {
	check("import RpcClient from npm dependency", typeof RpcClient === "function", cliPath);
	check("cli.js exists next to package entry", existsSync(cliPath));

	// --- workspace: repo + worktree + card folder (artifacts live outside the worktree)
	const root = join(here, ".tmp", `run-${Date.now()}`);
	const repo = join(root, "repo");
	const worktree = join(root, "wt-card-1");
	const cardDir = join(root, "card-1");
	const sessionDir = join(cardDir, "sessions");
	mkdirSync(repo, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "README.md"), "# spike repo\n");
	git(repo, "add", ".");
	git(repo, "-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "init");
	git(repo, "worktree", "add", "-q", "-b", "tc/card-1", worktree);
	check("git worktree created", existsSync(join(worktree, "README.md")), worktree);

	const log: AnyEvent[] = [];
	const sessionId = "card-1.plan.1";
	const baseArgs = ["--session-dir", sessionDir, "--session-id", sessionId, "--no-extensions", "-na"];
	const spawnClient = (extraArgs: string[] = [], model = MODEL) =>
		new PiClient({ cliPath, cwd: worktree, env: env(), args: [...baseArgs, "--model", model, ...extraArgs] });

	// --- 1. spawn, prompt, stream, settle, write inside and outside the worktree
	let client = spawnClient();
	const startedAt = Date.now();
	await client.start();
	let events = track(client, log);
	const state = await client.getState();
	check("spawn in worktree + getState", true, `${Date.now() - startedAt}ms, model=${JSON.stringify((state as { model?: { id?: string } }).model?.id)}`);

	const planPath = join(cardDir, "plan.md");
	let settled = events.settled();
	await client.prompt(
		`Do exactly two things, then stop. 1) Write the text "hello" to hello.txt in the current directory. 2) Write a one-line plan to the absolute path ${planPath}.`,
	);
	await settled;
	const types = events.seen.map((e) => e.type);
	check("text/tool deltas streamed", types.includes("message_update"));
	check("message_end received", types.includes("message_end"));
	check("agent_settled arrives after agent_end", types.lastIndexOf("agent_settled") > types.lastIndexOf("agent_end") && types.includes("agent_end"));
	// Finding: entry_appended only fires for extension custom entries (agent-session.js appendEntry), never for
	// messages, so the durable transcript anchors on message_end + getEntries(since) instead.
	const lastMessageEnd = events.seen.findLast((e) => e.type === "message_end") as { message?: { role?: string } } | undefined;
	check("message_end carries the authoritative message", lastMessageEnd?.message?.role !== undefined);
	check("write inside worktree", existsSync(join(worktree, "hello.txt")));
	check("write artifact OUTSIDE worktree by absolute path", existsSync(planPath), planPath);

	// --- 2. steer mid-run
	let steered = false;
	events.on((e) => {
		if (!steered && e.type === "tool_execution_start") {
			steered = true;
			void client.steer("Change of plan: skip any remaining sleeps and do NOT write a.txt. Write goodbye.txt containing 'bye' instead, then stop.");
		}
	});
	const before = events.seen.length;
	settled = events.settled();
	await client.prompt("Run `sleep 4` with bash three separate times (three tool calls), then write a.txt containing 'a'.");
	await settled;
	const steerTypes = events.seen.slice(before).map((e) => e.type);
	check("steer accepted mid-run (queue_update seen)", steered && steerTypes.includes("queue_update"));
	check("steer changed the outcome", existsSync(join(worktree, "goodbye.txt")) && !existsSync(join(worktree, "a.txt")));

	// --- 3. stats
	const stats = (await client.getSessionStats()) as { tokens: { total: number }; cost: number };
	check("getSessionStats tokens non-zero", stats.tokens.total > 0, `tokens=${stats.tokens.total} cost=$${stats.cost}`);

	// --- 4. kill and resume by the same session id
	const beforeStop = await client.getEntries();
	const cursor = beforeStop.entries.at(-1)?.id as string;
	await client.stop();
	client = spawnClient();
	await client.start();
	events = track(client, log);
	const resumedMessages = await client.getMessages();
	check("resume by --session-id restores history", resumedMessages.length > 0, `${resumedMessages.length} messages`);
	const none = await client.getEntries(cursor);
	settled = events.settled();
	await client.prompt("Reply with the single word: resumed");
	await settled;
	const some = await client.getEntries(cursor);
	check("getEntries(since) is a durable cursor", none.entries.length === 0 && some.entries.length > 0, `0 then ${some.entries.length}`);
	await client.stop();

	// --- 5. extension UI request answered via stdin
	const extPath = join(root, "confirm-ext.ts");
	writeFileSync(
		extPath,
		`export default function (pi) {
	pi.registerCommand("tc-confirm", {
		description: "spike: blocking confirm",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Proceed?", "spike check");
			ctx.ui.notify("tc-confirm=" + ok, "info");
		},
	});
}
`,
	);
	client = new PiClient({
		cliPath,
		cwd: worktree,
		env: env(),
		args: ["--session-dir", sessionDir, "--session-id", "card-1.ui.1", "--no-extensions", "-na", "-e", extPath, "--model", MODEL],
	});
	await client.start();
	events = track(client, log);
	const uiDone = new Promise<{ requested: boolean; notified: boolean }>((resolve) => {
		let requested = false;
		const timer = setTimeout(() => resolve({ requested, notified: false }), 20_000);
		events.on((e) => {
			if (e.type !== "extension_ui_request") return;
			if (e.method === "confirm") {
				requested = true;
				client.respondToUi({ type: "extension_ui_response", id: e.id as string, confirmed: true });
			} else if (e.method === "notify" && String(e.message).includes("tc-confirm=true")) {
				clearTimeout(timer);
				resolve({ requested, notified: true });
			}
		});
	});
	await client.prompt("/tc-confirm");
	const ui = await uiDone;
	check("extension_ui_request reaches onEvent", ui.requested);
	check("stdin extension_ui_response unblocks the extension", ui.notified);
	await client.stop();

	// --- 6. model outside enabledModels is accepted (no prompt sent, no tokens spent)
	client = new PiClient({
		cliPath,
		cwd: worktree,
		env: env(),
		args: ["--session-dir", sessionDir, "--session-id", "card-1.alt.1", "--no-extensions", "-na", "--model", ALT_MODEL],
	});
	await client.start();
	const altState = (await client.getState()) as { model?: { provider?: string; id?: string } };
	const altId = `${altState.model?.provider}/${altState.model?.id}`;
	check("model outside enabledModels accepted via --model", altId === ALT_MODEL, altId);
	await client.stop();

	// --- fixture for FakeSessionDriver
	const fixtureDir = join(here, "..", "packages", "daemon", "test", "fixtures");
	mkdirSync(fixtureDir, { recursive: true });
	const fixture = join(fixtureDir, "spike-events.jsonl");
	writeFileSync(fixture, `${log.map((e) => JSON.stringify(e)).join("\n")}\n`);
	console.log(`\nfixture: ${fixture} (${log.length} events, ${readFileSync(fixture).byteLength} bytes)`);

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("spike crashed:", error);
	process.exit(2);
});
