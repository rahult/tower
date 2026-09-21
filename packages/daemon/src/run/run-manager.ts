import type { RunSpec } from "@traffic-control/core";
import type { Db } from "../db/open.ts";
import { insertRunEvent, listRunEvents } from "../db/repo-events.ts";
import type { Bus } from "../events/bus.ts";
import type { DriverEvent, RunHandle, SessionDriver } from "../pi/session-driver.ts";
import { TranscriptBuffer, type TranscriptItem } from "./transcript-buffer.ts";

export interface LiveRun {
	runId: string;
	cardId: string;
	/** Null for daemon-run work such as the verify command, which has a transcript but no agent session. */
	handle: RunHandle | null;
	buffer: TranscriptBuffer;
	/** Stops recording driver events into the transcript. */
	detach: () => void;
}

/**
 * Owns live sessions. Enforces one live run per card (one writer per worktree and per session file), and turns
 * driver events into transcript items that are buffered, persisted (anchors only) and published.
 */
export class RunManager {
	private readonly byRun = new Map<string, LiveRun>();
	private readonly byCard = new Map<string, string>();
	private readonly db: Db;
	private readonly bus: Bus;
	private readonly driver: SessionDriver;

	constructor(db: Db, bus: Bus, driver: SessionDriver) {
		this.db = db;
		this.bus = bus;
		this.driver = driver;
	}

	async start(cardId: string, spec: RunSpec): Promise<LiveRun> {
		if (this.byCard.has(cardId)) throw new Error(`Card ${cardId} already has a live run`);
		const runId = spec.sessionId;
		// Reserve before the await so two concurrent starts cannot both pass the check.
		this.byCard.set(cardId, runId);
		try {
			const handle = await this.driver.start(spec);
			const live: LiveRun = { runId, cardId, handle, buffer: this.createBuffer(cardId, runId), detach: () => {} };
			live.detach = handle.onEvent((event) => this.record(live, event));
			this.byRun.set(runId, live);
			return live;
		} catch (error) {
			this.byCard.delete(cardId);
			throw error;
		}
	}

	/** Opens a transcript for daemon-run work. Holds the card's lease like a session does. */
	openLog(cardId: string, runId: string): LiveRun {
		if (this.byCard.has(cardId)) throw new Error(`Card ${cardId} already has a live run`);
		const live: LiveRun = { runId, cardId, handle: null, buffer: this.createBuffer(cardId, runId), detach: () => {} };
		this.byCard.set(cardId, runId);
		this.byRun.set(runId, live);
		return live;
	}

	private createBuffer(cardId: string, runId: string): TranscriptBuffer {
		return new TranscriptBuffer({
			onItem: (item, durable) => {
				if (durable) insertRunEvent(this.db, cardId, runId, item);
				this.bus.publish({ topic: `run:${runId}`, type: item.type, data: item, seq: item.seq });
			},
		});
	}

	private record(live: LiveRun, event: DriverEvent): void {
		if (event.type === "text" || event.type === "thinking") {
			live.buffer.pushDelta(event.type, event.delta);
			return;
		}
		const { type, ...payload } = event;
		live.buffer.push(type, payload);
	}

	/** Records something the daemon did (sent a prompt, a lifecycle note) in the run's transcript. */
	note(runId: string, type: string, payload: unknown): void {
		this.byRun.get(runId)?.buffer.push(type, payload);
	}

	liveRunForCard(cardId: string): LiveRun | null {
		const runId = this.byCard.get(cardId);
		return runId ? (this.byRun.get(runId) ?? null) : null;
	}

	/** Live runs replay from the ring buffer; finished runs replay from persisted anchors. */
	transcript(runId: string, since = 0): { items: TranscriptItem[]; lastSeq: number; droppedBefore: number; live: boolean } {
		const live = this.byRun.get(runId);
		if (live) {
			const { items, droppedBefore } = live.buffer.snapshot(since);
			return { items, lastSeq: live.buffer.lastSeq, droppedBefore, live: true };
		}
		const items = listRunEvents(this.db, runId, since);
		return { items, lastSeq: items.at(-1)?.seq ?? since, droppedBefore: 0, live: false };
	}

	async finish(runId: string): Promise<void> {
		const live = this.byRun.get(runId);
		if (!live) return;
		// Detach first: stopping the session kills the process, and our own cleanup is not a transcript event.
		live.detach();
		live.buffer.close();
		this.byRun.delete(runId);
		this.byCard.delete(live.cardId);
		await live.handle?.stop().catch(() => {});
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.byRun.keys()].map((runId) => this.finish(runId)));
	}
}
