/**
 * Tower's pi extension: drive the Tower daemon from inside any pi session.
 *
 *   /tower                 start the daemon if needed and open the board
 *   /tower add <title>     add a card for this repository to the backlog
 *   /tower run <title>     add a card and start it (planning begins when a slot is free)
 *   /tower status          what is running and what is waiting for you
 *   /tower settings        show which model runs each stage
 *   /tower settings planning=zai/glm-5.3 building=zai/glm-5.3-flash:low
 *                          set them (":thinking" is optional; "stage=default" clears one)
 *   /tower update         fast-forward this install to origin, rebuild the board, say if a restart is needed
 *   /tower rebuild-ui      build the board UI (after pulling updates); reload the tab to see it
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
const SUBCOMMANDS = ["open", "add", "run", "status", "settings", "update", "rebuild-ui", "stop"];

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

interface Settings {
	models: Record<string, { model: string; thinking: string; source: "config" | "default" }>;
	file: string;
}

/** `/tower settings` shows the models; `/tower settings planning=provider/model[:thinking] …` changes them. */
async function settings(args: string[], ctx: ExtensionContext): Promise<void> {
	await ensureRunning(ctx);
	let current = await api<Settings>("GET", "/api/settings");
	if (args.length > 0) {
		// Start from what is configured now, so setting one stage leaves the others alone.
		const models: Record<string, { model: string; thinking?: string } | null> = {};
		for (const [stage, value] of Object.entries(current.models)) if (value.source === "config") models[stage] = { model: value.model, thinking: value.thinking };
		for (const arg of args) {
			const [stage, value] = arg.split("=", 2);
			if (!stage || !value) throw new Error(`"${arg}" is not stage=provider/model. Example: /tower settings planning=zai/glm-5.3 building=zai/glm-5.3-flash:low`);
			if (value === "default") {
				models[stage] = null;
				continue;
			}
			const colon = value.lastIndexOf(":");
			models[stage] = colon > value.indexOf("/") ? { model: value.slice(0, colon), thinking: value.slice(colon + 1) } : { model: value, ...(models[stage]?.thinking ? { thinking: models[stage]?.thinking } : {}) };
		}
		current = await api<Settings>("PUT", "/api/settings", { models });
	}
	const lines = Object.entries(current.models).map(([stage, value]) => `  ${stage.padEnd(9)} ${value.model}, thinking ${value.thinking}${value.source === "default" ? " (Tower's default)" : ""}`);
	ctx.ui.notify([`Tower models${args.length > 0 ? " saved" : ""} (${current.file}):`, ...lines, "Change with: /tower settings planning=provider/model[:thinking] building=…"].join("\n"), "info");
}

async function stop(ctx: ExtensionContext): Promise<void> {
	const pidFile = join(HOME, "daemon.pid");
	if (!(await isUp()) || !existsSync(pidFile)) return ctx.ui.notify("Tower is not running.", "info");
	process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
	ctx.ui.notify("Tower: stopping. Sessions that were running can be resumed from the board next time.", "info");
}

/**
 * The daemon serves the built board from packages/web/dist per request, so the UI only changes when
 * that directory is rebuilt. After pulling Tower updates (or editing the board), this rebuilds it;
 * the new board then appears on a page reload — no daemon restart needed.
 */
async function rebuildUi(ctx: ExtensionContext): Promise<void> {
	ctx.ui.notify("Tower: building the board UI…", "info");
	const started = Date.now();
	await run("npm", ["run", "build", "--workspace", "@tower/web"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
	ctx.ui.notify(`Tower: UI rebuilt in ${Math.round((Date.now() - started) / 1000)}s. Reload the board tab (${BASE}) to pick it up.`, "info");
}

/**
 * `/tower update`: fast-forwards this install to origin and rebuilds the board. The running daemon
 * keeps its boot-time code, so when daemon, prompt or flow files changed, the reader is told to
 * restart rather than left on a half-updated install.
 */
async function update(ctx: ExtensionContext): Promise<void> {
	const git = (...args: string[]) => run("git", args, { cwd: ROOT, maxBuffer: 1024 * 1024 });
	const branch = (await git("rev-parse", "--abbrev-ref", "HEAD").catch(() => null))?.stdout.trim();
	if (!branch || branch === "HEAD") throw new Error(`${ROOT} is not a checkout of a branch, so there is nothing to pull. Reinstall: pi install git:github.com/rahult/tower`);
	// Untracked files are common and harmless; modified tracked files would make the fast-forward a mess.
	const dirty = (await git("status", "--porcelain", "--untracked-files=no")).stdout.trim();
	if (dirty) throw new Error("This install has local changes, so Tower did not pull over them. Commit or discard them there, then /tower update again.");
	const ahead = Number((await git("rev-list", "--count", `origin/${branch}..HEAD`)).stdout.trim());
	if (ahead > 0) throw new Error(`This install is ${ahead} ${ahead === 1 ? "commit" : "commits"} ahead of origin/${branch}; update it by hand instead of force-pulling.`);

	const before = (await git("rev-parse", "HEAD")).stdout.trim();
	await git("fetch", "origin", branch);
	const behind = Number((await git("rev-list", "--count", `HEAD..origin/${branch}`)).stdout.trim());
	if (behind === 0) return ctx.ui.notify(`Tower is already up to date (${before.slice(0, 7)}).`, "info");

	await git("merge", "--ff-only", `origin/${branch}`);
	const after = (await git("rev-parse", "HEAD")).stdout.trim();
	const commits = Number((await git("rev-list", "--count", `${before}..${after}`)).stdout.trim());
	// Daemon code runs from boot time; prompts and flows are read per run, where the new files can fail
	// one stage until a restart — both argue for restarting, and Retry recovers a stage that caught the skew.
	const needsRestart = (await git("diff", "--name-only", `${before}..${after}`, "--", "packages/daemon", "prompts", "flows")).stdout.trim().length > 0;
	ctx.ui.notify("Tower: building the board UI…", "info");
	await run("npm", ["run", "build", "--workspace", "@tower/web"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
	ctx.ui.notify(
		[
			`Tower: updated ${before.slice(0, 7)} → ${after.slice(0, 7)} (${commits} ${commits === 1 ? "commit" : "commits"}). UI rebuilt — reload the board tab (${BASE}).`,
			...(needsRestart ? ["The daemon, prompts or flows changed: /tower stop, then /tower, to pick them up. (A stage that fails meanwhile recovers on Retry.)"] : []),
		].join("\n"),
		needsRestart ? "warning" : "info",
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tower", {
		description: "Tower control board: /tower [open | add <title> | run <title> | status | settings | update | rebuild-ui | stop]",
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
				else if (subcommand === "settings") await settings(rest, ctx);
				else if (subcommand === "update") await update(ctx);
				else if (subcommand === "rebuild-ui") await rebuildUi(ctx);
				else if (subcommand === "stop") await stop(ctx);
				else ctx.ui.notify(`Unknown: /tower ${subcommand}. Try: ${SUBCOMMANDS.join(", ")}`, "warning");
			} catch (error) {
				ctx.ui.notify(`Tower: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
