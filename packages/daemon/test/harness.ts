import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE_RESULT_FILE } from "@tower/core";
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
	/** Stops the daemon the way SIGTERM does and boots a new one on the same data directory. */
	restart(script?: FakeScript): Promise<void>;
	close(): Promise<void>;
}

/** Boots the real daemon on an ephemeral port with a real temp git repo, a real SQLite file and a scripted driver. */
export async function bootHarness(script: FakeScript, env: Record<string, string> = {}): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "tower-test-"));
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "README.md"), "# test repo\n");
	git("add", ".");
	git("-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "init");

	// Read afresh on every boot, as a real restart does, so tests of persisted settings mean something.
	const config = () => loadConfig({ TOWER_HOME: home, TOWER_PORT: "0", ...env });
	const readers: SseReader[] = [];
	const harness = { driver: new FakeSessionDriver(script), daemon: undefined as unknown as Daemon };
	harness.daemon = await startDaemon(config(), harness.driver);

	return {
		get daemon() {
			return harness.daemon;
		},
		get driver() {
			return harness.driver;
		},
		home,
		repo,
		async restart(nextScript = script) {
			for (const reader of readers.splice(0)) reader.close();
			await harness.daemon.close();
			harness.driver = new FakeSessionDriver(nextScript);
			harness.daemon = await startDaemon(config(), harness.driver);
		},
		async api(method, path, body) {
			const response = await fetch(`${harness.daemon.url}${path}`, {
				method,
				headers: body === undefined ? {} : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await response.text();
			return { status: response.status, body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
		},
		stream(topics, options = {}) {
			const reader = new SseReader(`${harness.daemon.url}/api/stream?topics=${topics}&since=${options.since ?? 0}`, options.lastEventId);
			readers.push(reader);
			return reader;
		},
		async close() {
			for (const reader of readers) reader.close();
			await harness.daemon.close();
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

/** A plan with the things real plans contain (table, code, checklist), so the UI's rendering can be looked at. */
const SAMPLE_PLAN = `# Plan

## Context and goal

Requests to the payments API fail on transient **5xx** and network errors. Wrap \`request()\` so they are retried with backoff, without changing its signature.

| Choice | Decision | Why |
|---|---|---|
| Strategy | Exponential backoff with jitter | Avoids synchronised retries |
| Attempts | 5 | Matches the gateway's timeout budget |

## Steps

1. Do the thing.
2. Add \`retry.ts\`:

\`\`\`ts
export async function withRetry<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (error) {
      if (i === attempts - 1 || !isTransient(error)) throw error;
      await sleep(2 ** i * 100 + Math.random() * 100); // jitter
    }
  }
}
\`\`\`

## Verify

- [ ] \`pnpm test --filter http\`
- [ ] \`pnpm typecheck\`

> Do not retry 4xx responses: they will not get better.
`;

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
			writeFileSync(join(cardDir, "plan.md"), SAMPLE_PLAN);
			if (options.writeResult !== false) writeFileSync(join(cardDir, STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Plan ready." }));
		},
	};
}

/** A scripted building turn: changes a file in the worktree, commits it, and reports a pass. */
export function buildingTurn(): FakeTurn {
	return {
		events: [{ type: "message", message: { role: "assistant", text: "Implemented.", thinking: "", toolCalls: [] } }],
		effect: ({ spec }) => {
			// Unique per session so a rebuild always has something to commit.
			writeFileSync(join(spec.cwd, "feature.txt"), `new feature\nbuilt by ${spec.sessionId}\n`);
			writeFileSync(join(spec.cwd, "scratch.tmp"), "left untracked\n");
			execFileSync("git", ["add", "feature.txt"], { cwd: spec.cwd });
			execFileSync("git", ["-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "Add feature"], { cwd: spec.cwd });
			writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Built." }));
		},
	};
}

/** A scripted tester turn: writes a report and passes. */
export function testerTurn(): FakeTurn {
	return {
		events: [],
		effect: ({ spec }) => {
			writeFileSync(join(spec.sessionDir, "..", "test-report.md"), "# Report\n\nAll good.\n");
			writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Checks pass." }));
		},
	};
}

/** Scripts each session by its stage, so re-plans, rebuilds and tests each behave like the right agent. */
export function byStage(overrides: { build?: () => FakeTurn } = {}): FakeScript {
	return (spec) => {
		if (spec.sessionId.includes("-plan-")) return [planningTurn()];
		if (spec.sessionId.includes("-build-")) return [overrides.build?.() ?? buildingTurn()];
		return [testerTurn()];
	};
}
