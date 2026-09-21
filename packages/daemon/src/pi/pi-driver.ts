import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { RunSpec } from "@tower/core";
import { buildPiArgs } from "./argv.ts";
import { normalise } from "./normalise.ts";
import type { DriverEvent, RunHandle, RunStats, SessionDriver, UiAnswer } from "./session-driver.ts";

/** The pi CLI shipped with the pinned dependency, so children match the types this daemon was built against. */
export function resolvePiCliPath(): string {
	return join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
}

/**
 * RpcClient has no public way to answer extension_ui_request (send() is private and overwrites the id) or to
 * observe process exit. `process` is a TS-private plain field, so a subclass can reach it at runtime.
 */
class PiRpcClient extends RpcClient {
	child(): ChildProcess | null {
		return (this as unknown as { process: ChildProcess | null }).process;
	}
	writeLine(payload: unknown): void {
		this.child()?.stdin?.write(`${JSON.stringify(payload)}\n`);
	}
}

export interface PiDriverOptions {
	cliPath?: string;
	env?: NodeJS.ProcessEnv;
}

export class PiSessionDriver implements SessionDriver {
	private readonly cliPath: string;
	private readonly env: Record<string, string>;

	constructor(options: PiDriverOptions = {}) {
		this.cliPath = options.cliPath ?? resolvePiCliPath();
		const source = options.env ?? process.env;
		const env = Object.fromEntries(Object.entries(source).filter((e): e is [string, string] => e[1] !== undefined));
		// RpcClient spawns bare `node`; make sure it is the node running this daemon even under launchd.
		env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ""}`;
		this.env = env;
	}

	async start(spec: RunSpec): Promise<RunHandle> {
		const client = new PiRpcClient({ cliPath: this.cliPath, cwd: spec.cwd, env: this.env, args: buildPiArgs(spec) });
		await client.start();
		const handle = new PiRunHandle(spec.sessionId, client);
		// start() only waits 100ms, so a child that dies on bad auth "starts" fine. A cheap command surfaces that here.
		try {
			await client.getState();
		} catch (error) {
			await client.stop().catch(() => {});
			throw new Error(`pi session failed to start: ${error instanceof Error ? error.message : String(error)}`);
		}
		return handle;
	}
}

class PiRunHandle implements RunHandle {
	readonly sessionId: string;
	private readonly client: PiRpcClient;
	private readonly listeners = new Set<(event: DriverEvent) => void>();
	private settleWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	private exited = false;

	constructor(sessionId: string, client: PiRpcClient) {
		this.sessionId = sessionId;
		this.client = client;
		// One permanent subscription. Never waitForIdle/promptAndWait: they subscribe late and time out at 60s.
		client.onEvent((raw) => {
			for (const event of normalise(raw as unknown as { type: string })) this.emit(event);
		});
		client.child()?.once("exit", (code) => {
			this.exited = true;
			this.emit({ type: "exit", code, stderr: client.getStderr().slice(-4000) });
		});
	}

	get pid(): number | null {
		return this.client.child()?.pid ?? null;
	}

	private emit(event: DriverEvent): void {
		for (const listener of this.listeners) listener(event);
		if (event.type !== "settled" && event.type !== "exit") return;
		const waiters = this.settleWaiters;
		this.settleWaiters = [];
		for (const waiter of waiters) {
			if (event.type === "settled") waiter.resolve();
			else waiter.reject(new Error(`pi session exited with code ${event.code}`));
		}
	}

	onEvent(listener: (event: DriverEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		await this.client.prompt(text);
	}

	async steer(text: string): Promise<void> {
		await this.client.steer(text);
	}

	async abort(): Promise<void> {
		await this.client.abort();
	}

	answerUi(requestId: string, answer: UiAnswer): void {
		this.client.writeLine({ type: "extension_ui_response", id: requestId, ...answer });
	}

	async stats(): Promise<RunStats> {
		const stats = await this.client.getSessionStats();
		return { tokens: stats.tokens, costUsd: stats.cost };
	}

	async lastEntryId(): Promise<string | null> {
		const { entries } = await this.client.getEntries();
		return entries.at(-1)?.id ?? null;
	}

	waitSettled(): Promise<void> {
		if (this.exited) return Promise.reject(new Error("pi session has already exited"));
		return new Promise((resolve, reject) => this.settleWaiters.push({ resolve, reject }));
	}

	async stop(): Promise<void> {
		await this.client.stop();
	}
}
