/**
 * Tower's pi extension: drive the Tower daemon from inside any pi session.
 *
 *   /tower                 start the daemon if needed and open the board
 *   /tower add <title>     add a card for this repository to the backlog
 *   /tower run <title>     add a card and start it (planning begins when a slot is free)
 *   /tower status          what is running and what is waiting for you
 *   /tower stop            stop the daemon (running sessions become resumable)
 *
 * The daemon is a separate long-running process, so it keeps working after this pi session ends. It inherits
 * this session's environment, which is how provider API keys reach the pi sessions it spawns.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.TOWER_HOME ?? join(homedir(), ".tower");
const PORT = process.env.TOWER_PORT ?? "4700";
const BASE = `http://127.0.0.1:${PORT}`;
const SUBCOMMANDS = ["open", "add", "run", "status", "stop"];

interface Card {
	id: string;
	projectId: string;
	title: string;
	stage: string;
	status: string;
	needsAttentionReason: string | null;
}
interface Board {
	projects: Array<{ id: string; name: string; repoPath: string }>;
	cards: Card[];
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	const payload = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new Error(payload.error ?? response.statusText);
	return payload;
}

async function isUp(): Promise<boolean> {
	try {
		return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) })).ok;
	} catch {
		return false;
	}
}

/** The daemon runs its TypeScript directly, which needs Node's built-in type stripping. */
function nodeForDaemon(): string {
	const [major = 0, minor = 0] = (process.versions.node ?? "0.0").split(".").map(Number);
	if (process.versions.bun || major < 22 || (major === 22 && minor < 18)) {
		throw new Error(`Tower's daemon needs Node 22.18 or newer (this pi runs on ${process.versions.bun ? "Bun" : `Node ${process.versions.node}`}). Start it yourself: node ${join(ROOT, "packages/daemon/src/main.ts")}`);
	}
	return process.execPath;
}

async function ensureRunning(ctx: ExtensionContext): Promise<void> {
	if (await isUp()) return;
	const node = nodeForDaemon();
	if (!existsSync(join(ROOT, "packages", "web", "dist", "index.html"))) {
		ctx.ui.notify("Tower: building the board UI (first run only)…", "info");
		await run("npm", ["run", "build", "--workspace", "@tower/web"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
	}
	mkdirSync(HOME, { recursive: true });
	const log = openSync(join(HOME, "daemon.log"), "a");
	const child = spawn(node, [join(ROOT, "packages", "daemon", "src", "main.ts")], { cwd: ROOT, detached: true, stdio: ["ignore", log, log], env: process.env });
	child.unref();
	closeSync(log);
	for (let i = 0; i < 60; i++) {
		if (await isUp()) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Tower's daemon did not come up. See ${join(HOME, "daemon.log")}`);
}

function openInBrowser(url: string): void {
	const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	spawn(command, args as string[], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

/** Finds this repository on the board, adding it as a project the first time. */
async function projectForCwd(cwd: string): Promise<{ id: string; name: string }> {
	let repoPath: string;
	try {
		repoPath = realpathSync((await run("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim());
	} catch {
		throw new Error("This directory is not inside a git repository, so Tower cannot make worktrees for it.");
	}
	const board = await api<Board>("GET", "/api/board");
	return board.projects.find((project) => realpathSync(project.repoPath) === repoPath) ?? (await api("POST", "/api/projects", { repoPath }));
}

async function addCard(args: string, ctx: ExtensionContext, start: boolean): Promise<void> {
	const title = args.trim();
	if (!title) throw new Error(`Say what should be done, for example: /tower ${start ? "run" : "add"} Add retry with backoff to the HTTP client`);
	await ensureRunning(ctx);
	const project = await projectForCwd(ctx.cwd);
	const card = await api<Card>("POST", "/api/cards", { projectId: project.id, title });
	if (start) await api("POST", `/api/cards/${card.id}/enqueue`);
	ctx.ui.notify(`Tower: ${start ? "started" : "added to the backlog of"} ${project.name}: ${title} (${card.id}). Board: ${BASE}`, "info");
}

async function status(ctx: ExtensionContext): Promise<void> {
	if (!(await isUp())) return ctx.ui.notify("Tower is not running. /tower starts it.", "info");
	const { cards, projects } = await api<Board>("GET", "/api/board");
	const name = (card: Card) => projects.find((project) => project.id === card.projectId)?.name ?? "?";
	const running = cards.filter((card) => ["running", "verifying", "queued"].includes(card.status));
	const needYou = cards.filter((card) => ["awaiting_gate", "awaiting_input", "needs_attention", "interrupted"].includes(card.status));
	const line = (card: Card) => `  ${name(card)}: ${card.title} (${card.stage}, ${card.status.replaceAll("_", " ")})${card.needsAttentionReason ? `\n    ${card.needsAttentionReason}` : ""}`;
	ctx.ui.notify(
		[`Tower at ${BASE}: ${running.length} running or queued, ${needYou.length} waiting for you, ${cards.length} cards.`, ...needYou.map(line), ...running.map(line)].join("\n"),
		needYou.length > 0 ? "warning" : "info",
	);
}

async function stop(ctx: ExtensionContext): Promise<void> {
	const pidFile = join(HOME, "daemon.pid");
	if (!(await isUp()) || !existsSync(pidFile)) return ctx.ui.notify("Tower is not running.", "info");
	process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
	ctx.ui.notify("Tower: stopping. Sessions that were running can be resumed from the board next time.", "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tower", {
		description: "Tower control board: /tower [open | add <title> | run <title> | status | stop]",
		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const [subcommand = "open", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (subcommand === "open") {
					await ensureRunning(ctx);
					openInBrowser(BASE);
					ctx.ui.notify(`Tower is running: ${BASE}`, "info");
				} else if (subcommand === "add" || subcommand === "run") await addCard(rest.join(" "), ctx, subcommand === "run");
				else if (subcommand === "status") await status(ctx);
				else if (subcommand === "stop") await stop(ctx);
				else ctx.ui.notify(`Unknown: /tower ${subcommand}. Try: ${SUBCOMMANDS.join(", ")}`, "warning");
			} catch (error) {
				ctx.ui.notify(`Tower: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
