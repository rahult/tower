import type { RunSpec } from "@traffic-control/core";
import type { DriverEvent, RunHandle, RunStats, SessionDriver, UiAnswer } from "./session-driver.ts";

/** What a fake session does in response to one prompt. */
export interface FakeTurn {
	events: DriverEvent[];
	/** Side effect run before the turn settles, e.g. writing the artifacts a real agent would write. */
	effect?: (ctx: { spec: RunSpec; prompt: string }) => void | Promise<void>;
	/** Delay between events, so tests can steer or abort mid-turn. */
	delayMs?: number;
}

export type FakeScript = (spec: RunSpec) => FakeTurn[];

/** Scripted SessionDriver for tests. Turn N of the script answers prompt N; a `settled` event is appended to each turn. */
export class FakeSessionDriver implements SessionDriver {
	readonly handles: FakeRunHandle[] = [];
	private readonly script: FakeScript;

	constructor(script: FakeScript) {
		this.script = script;
	}

	async start(spec: RunSpec): Promise<RunHandle> {
		const handle = new FakeRunHandle(spec, this.script(spec));
		this.handles.push(handle);
		return handle;
	}
}

export class FakeRunHandle implements RunHandle {
	readonly sessionId: string;
	readonly pid = null;
	readonly spec: RunSpec;
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	readonly uiAnswers: Array<{ requestId: string; answer: UiAnswer }> = [];
	stopped = false;
	private readonly turns: FakeTurn[];
	private readonly listeners = new Set<(event: DriverEvent) => void>();
	private settleWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	private aborted = false;

	constructor(spec: RunSpec, turns: FakeTurn[]) {
		this.spec = spec;
		this.sessionId = spec.sessionId;
		this.turns = turns;
	}

	private emit(event: DriverEvent): void {
		for (const listener of this.listeners) listener(event);
		if (event.type !== "settled") return;
		const waiters = this.settleWaiters;
		this.settleWaiters = [];
		for (const waiter of waiters) waiter.resolve();
	}

	onEvent(listener: (event: DriverEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		const turn = this.turns[this.prompts.length] ?? { events: [] };
		this.prompts.push(text);
		this.aborted = false;
		void this.play(turn, text);
	}

	private async play(turn: FakeTurn, prompt: string): Promise<void> {
		await Promise.resolve();
		for (const event of turn.events) {
			if (this.aborted) break;
			if (turn.delayMs) await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
			this.emit(event);
		}
		if (!this.aborted) await turn.effect?.({ spec: this.spec, prompt });
		this.emit({ type: "settled" });
	}

	async steer(text: string): Promise<void> {
		this.steers.push(text);
		this.emit({ type: "queue", steering: [text], followUp: [] });
	}

	async abort(): Promise<void> {
		this.aborted = true;
	}

	answerUi(requestId: string, answer: UiAnswer): void {
		this.uiAnswers.push({ requestId, answer });
	}

	async stats(): Promise<RunStats> {
		return { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 }, costUsd: 0.001 };
	}

	async lastEntryId(): Promise<string | null> {
		return `entry-${this.prompts.length}`;
	}

	waitSettled(): Promise<void> {
		return new Promise((resolve, reject) => this.settleWaiters.push({ resolve, reject }));
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}
}
