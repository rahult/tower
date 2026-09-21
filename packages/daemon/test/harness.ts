import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE_RESULT_FILE } from "@traffic-control/core";
import { loadConfig } from "../src/config.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { type FakeScript, FakeSessionDriver, type FakeTurn } from "../src/pi/fake-driver.ts";

export interface Harness {
	daemon: Daemon;
	driver: FakeSessionDriver;
	home: string;
	repo: string;
	api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
	stream(topics: string, options?: { since?: number; lastEventId?: string }): SseReader;
	close(): Promise<void>;
}

/** Boots the real daemon on an ephemeral port with a real temp git repo, a real SQLite file and a scripted driver. */
export async function bootHarness(script: FakeScript): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "tc-test-"));
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "README.md"), "# test repo\n");
	git("add", ".");
	git("-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "init");

	const driver = new FakeSessionDriver(script);
	const daemon = await startDaemon({ ...loadConfig({ TC_HOME: home, TC_PORT: "0" }) }, driver);
	const readers: SseReader[] = [];

	return {
		daemon,
		driver,
		home,
		repo,
		async api(method, path, body) {
			const response = await fetch(`${daemon.url}${path}`, {
				method,
				headers: body === undefined ? {} : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await response.text();
			return { status: response.status, body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
		},
		stream(topics, options = {}) {
			const reader = new SseReader(`${daemon.url}/api/stream?topics=${topics}&since=${options.since ?? 0}`, options.lastEventId);
			readers.push(reader);
			return reader;
		},
		async close() {
			for (const reader of readers) reader.close();
			await daemon.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export interface Frame {
	id?: string;
	topic: string;
	type: string;
	data: any;
}

/** Minimal SSE client: collects frames and lets a test wait for one. */
export class SseReader {
	readonly frames: Frame[] = [];
	private readonly controller = new AbortController();
	private waiters: Array<() => void> = [];

	constructor(url: string, lastEventId?: string) {
		void this.read(url, lastEventId);
	}

	private async read(url: string, lastEventId?: string): Promise<void> {
		try {
			const response = await fetch(url, { signal: this.controller.signal, headers: lastEventId ? { "Last-Event-ID": lastEventId } : {} });
			const decoder = new TextDecoder();
			let pending = "";
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				pending += decoder.decode(chunk, { stream: true });
				let boundary = pending.indexOf("\n\n");
				while (boundary !== -1) {
					this.parse(pending.slice(0, boundary));
					pending = pending.slice(boundary + 2);
					boundary = pending.indexOf("\n\n");
				}
			}
		} catch {
			// aborted on close
		}
	}

	private parse(block: string): void {
		const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
		if (field("event") === "ping") return;
		const data = field("data");
		if (!data) return;
		this.frames.push({ id: field("id"), ...JSON.parse(data) });
		const waiters = this.waiters;
		this.waiters = [];
		for (const wake of waiters) wake();
	}

	async waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.frames.find(predicate);
			if (found) return found;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`Timed out waiting for SSE frame. Saw: ${this.frames.map((f) => `${f.topic}/${f.type}`).join(", ")}`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, remaining);
				this.waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	close(): void {
		this.controller.abort();
	}
}

/** A scripted planning turn that behaves like a well-behaved agent: streams, writes plan.md and a passing result. */
export function planningTurn(options: { writeResult?: boolean; delayMs?: number } = {}): FakeTurn {
	return {
		delayMs: options.delayMs,
		events: [
			{ type: "thinking", delta: "Let me look around. " },
			{ type: "tool_start", id: "t1", name: "read", args: { path: "README.md" } },
			{ type: "tool_end", id: "t1", name: "read", isError: false, output: "# test repo" },
			{ type: "text", delta: "Plan " },
			{ type: "text", delta: "written." },
			{ type: "message", message: { role: "assistant", text: "Plan written.", thinking: "Let me look around. ", toolCalls: [] } },
		],
		effect: ({ spec }) => {
			// sessionDir is <home>/cards/<id>/sessions; artifacts live one level up.
			const cardDir = join(spec.sessionDir, "..");
			writeFileSync(join(cardDir, "plan.md"), "# Plan\n\n1. Do the thing.\n");
			if (options.writeResult !== false) writeFileSync(join(cardDir, STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Plan ready." }));
		},
	};
}
