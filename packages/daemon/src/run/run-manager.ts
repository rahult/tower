import type { RunSpec } from "@tower/core";
import type { Db } from "../db/open.ts";
import { insertRunEvent, lastRunSeq, listRunEvents } from "../db/repo-events.ts";
import type { Bus } from "../events/bus.ts";
import type { DriverEvent, RunHandle, SessionDriver, UiAnswer } from "../pi/session-driver.ts";
import { TranscriptBuffer, type TranscriptItem } from "./transcript-buffer.ts";

export interface LiveRun {
	runId: string;
	cardId: string;
	/** Null for daemon-run work such as the verify command, which has a transcript but no agent session. */
	handle: RunHandle | null;
	buffer: TranscriptBuffer;
	/** Stops recording driver events into the transcript. */
	detach: () => void;
	/** Set when this run continues an interrupted one: the last seq persisted before the interruption. */
	resumedFromSeq?: number;
}

/**
 * Owns live sessions. A card holds one run at a time — its writer, so a worktree never has two agents typing
 * in it — except while a crew runs, when the card's stage lease covers several member sessions at once
 * (parallel builders in their own worktrees, scouts that only read). Turns driver events into transcript
 * items that are buffered, persisted (anchors only) and published.
 */
export class RunManager {
	private readonly byRun = new Map<string, LiveRun>();
	private readonly byCard = new Map<string, Set<string>>();
	/** Blocking questions from pi extensions that nobody has answered yet, with the timer that will cancel each. */
	private readonly pendingUi = new Map<string, NodeJS.Timeout>();
	private readonly uiTimeoutMs: number;
	private readonly db: Db;
	private readonly bus: Bus;
	private readonly driver: SessionDriver;

	constructor(db: Db, bus: Bus, driver: SessionDriver, uiTimeoutMs = 5 * 60_000) {
		this.uiTimeoutMs = uiTimeoutMs;
		this.db = db;
		this.bus = bus;
		this.driver = driver;
	}

	/** `shared` lets a crew add member sessions while the card's lease is already held by the crew itself. */
	async start(cardId: string, spec: RunSpec, options: { shared?: boolean } = {}): Promise<LiveRun> {
		const held = this.byCard.get(cardId);
		if (held && held.size > 0 && !options.shared) throw new Error(`Card ${cardId} already has a live run`);
		const runId = spec.sessionId;
		// Reserve before the await so two concurrent starts cannot both pass the check.
		const set = held ?? new Set<string>();
		set.add(runId);
		this.byCard.set(cardId, set);
		try {
			const handle = await this.driver.start(spec);
			const resumedFromSeq = lastRunSeq(this.db, runId);
			const live: LiveRun = { runId, cardId, handle, buffer: this.createBuffer(cardId, runId), detach: () => {}, ...(resumedFromSeq > 0 ? { resumedFromSeq } : {}) };
			live.detach = handle.onEvent((event) => this.record(live, event));
			this.byRun.set(runId, live);
			return live;
		} catch (error) {
			this.release(cardId, runId);
			throw error;
		}
	}

	/** Opens a transcript for daemon-run work. Holds the card's lease like a session does. */
	openLog(cardId: string, runId: string): LiveRun {
		const held = this.byCard.get(cardId);
		if (held && held.size > 0) throw new Error(`Card ${cardId} already has a live run`);
		const live: LiveRun = { runId, cardId, handle: null, buffer: this.createBuffer(cardId, runId), detach: () => {} };
		this.byCard.set(cardId, new Set([runId]));
		this.byRun.set(runId, live);
		return live;
	}

	private createBuffer(cardId: string, runId: string): TranscriptBuffer {
		// A resumed run continues its seq after what is already persisted, so cursors held by clients stay valid.
		return new TranscriptBuffer(
			{
				onItem: (item, durable) => {
					if (durable) insertRunEvent(this.db, cardId, runId, item);
					this.bus.publish({ topic: `run:${runId}`, type: item.type, data: item, seq: item.seq });
				},
			},
			lastRunSeq(this.db, runId),
		);
	}

	private record(live: LiveRun, event: DriverEvent): void {
		if (event.type === "text" || event.type === "thinking") {
			live.buffer.pushDelta(event.type, event.delta);
			return;
		}
		const { type, ...payload } = event;
		live.buffer.push(type, payload);
		// An extension dialog blocks the agent until it is answered. Nobody may be watching, so it cannot wait forever.
		if (event.type === "ui_request" && event.blocking) {
			const key = `${live.runId}:${event.id}`;
			this.pendingUi.set(
				key,
				setTimeout(() => this.resolveUi(live, event.id, { cancelled: true }, "expired"), this.uiTimeoutMs),
			);
		}
	}

	/** Answers a blocking extension question. Returns false when it is no longer waiting. */
	answerUi(runId: string, requestId: string, answer: UiAnswer): boolean {
		const live = this.byRun.get(runId);
		if (!live || !this.pendingUi.has(`${runId}:${requestId}`)) return false;
		this.resolveUi(live, requestId, answer, "answered");
		return true;
	}

	private resolveUi(live: LiveRun, requestId: string, answer: UiAnswer, outcome: "answered" | "expired"): void {
		const key = `${live.runId}:${requestId}`;
		clearTimeout(this.pendingUi.get(key));
		if (!this.pendingUi.delete(key)) return;
		live.handle?.answerUi(requestId, answer);
		live.buffer.push("ui_resolved", { id: requestId, outcome });
	}

	/** Records something the daemon did (sent a prompt, a lifecycle note) in the run's transcript. */
	note(runId: string, type: string, payload: unknown): void {
		this.byRun.get(runId)?.buffer.push(type, payload);
	}

	liveRunForCard(cardId: string): LiveRun | null {
		const ids = this.byCard.get(cardId);
		const runId = ids ? [...ids].at(-1) : undefined;
		return runId ? (this.byRun.get(runId) ?? null) : null;
	}

	/** Every live session of the card: one for an ordinary run, several while a crew is in flight. */
	liveRunsForCard(cardId: string): LiveRun[] {
		const ids = this.byCard.get(cardId);
		return ids ? [...ids].map((runId) => this.byRun.get(runId)).filter((live): live is LiveRun => live !== undefined) : [];
	}

	/** Live runs replay from the ring buffer; finished runs replay from persisted anchors. */
	transcript(runId: string, since = 0): { items: TranscriptItem[]; lastSeq: number; droppedBefore: number; live: boolean } {
		const live = this.byRun.get(runId);
		if (live) {
			const { items, droppedBefore } = live.buffer.snapshot(since);
			// A resumed run's earlier history lives only in the database; the live buffer starts after it, so no overlap.
			const resumedFrom = live.resumedFromSeq ?? 0;
			const earlier = since < resumedFrom ? listRunEvents(this.db, runId, since).filter((item) => item.seq <= resumedFrom) : [];
			return { items: [...earlier, ...items], lastSeq: live.buffer.lastSeq, droppedBefore, live: true };
		}
		const items = listRunEvents(this.db, runId, since);
		return { items, lastSeq: items.at(-1)?.seq ?? since, droppedBefore: 0, live: false };
	}

	async finish(runId: string): Promise<void> {
		const live = this.byRun.get(runId);
		if (!live) return;
		for (const [key, timer] of this.pendingUi) {
			if (!key.startsWith(`${runId}:`)) continue;
			clearTimeout(timer);
			this.pendingUi.delete(key);
		}
		// Detach first: stopping the session kills the process, and our own cleanup is not a transcript event.
		live.detach();
		live.buffer.close();
		this.byRun.delete(runId);
		this.release(live.cardId, runId);
		await live.handle?.stop().catch(() => {});
	}

	private release(cardId: string, runId: string): void {
		const ids = this.byCard.get(cardId);
		if (!ids) return;
		ids.delete(runId);
		if (ids.size === 0) this.byCard.delete(cardId);
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.byRun.keys()].map((runId) => this.finish(runId)));
	}
}
