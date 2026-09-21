export interface TranscriptItem {
	seq: number;
	ts: number;
	type: string;
	payload: unknown;
}

export interface TranscriptBufferOptions {
	flushMs?: number;
	maxItems?: number;
	/** Called for every emitted item. `durable` is false for coalesced deltas, which are never persisted. */
	onItem: (item: TranscriptItem, durable: boolean) => void;
	now?: () => number;
}

type DeltaKind = "text" | "thinking";

/**
 * Per-run transcript: a monotonic seq, a bounded ring of recent items for mid-run replay, and delta coalescing
 * so a streaming response becomes a few frames per second instead of one per token.
 */
export class TranscriptBuffer {
	private readonly items: TranscriptItem[] = [];
	private readonly flushMs: number;
	private readonly maxItems: number;
	private readonly onItem: TranscriptBufferOptions["onItem"];
	private readonly now: () => number;
	private seq: number;
	private droppedBefore = 0;
	private pending: { kind: DeltaKind; text: string } | null = null;
	private timer: NodeJS.Timeout | null = null;

	constructor(options: TranscriptBufferOptions, startSeq = 0) {
		this.flushMs = options.flushMs ?? 50;
		this.maxItems = options.maxItems ?? 5000;
		this.onItem = options.onItem;
		this.now = options.now ?? Date.now;
		this.seq = startSeq;
	}

	get lastSeq(): number {
		return this.seq;
	}

	/** Emits a durable item. Pending deltas are flushed first so ordering is preserved. */
	push(type: string, payload: unknown): TranscriptItem {
		this.flush();
		return this.emit(type, payload, true);
	}

	pushDelta(kind: DeltaKind, delta: string): void {
		if (this.pending && this.pending.kind !== kind) this.flush();
		if (this.pending) this.pending.text += delta;
		else this.pending = { kind, text: delta };
		this.timer ??= setTimeout(() => this.flush(), this.flushMs);
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (!this.pending) return;
		const { kind, text } = this.pending;
		this.pending = null;
		this.emit(kind, { delta: text }, false);
	}

	/** Items with seq > since. `droppedBefore` > since means the ring lost items the caller has not seen. */
	snapshot(since = 0): { items: TranscriptItem[]; droppedBefore: number } {
		return { items: this.items.filter((item) => item.seq > since), droppedBefore: this.droppedBefore };
	}

	close(): void {
		this.flush();
	}

	private emit(type: string, payload: unknown, durable: boolean): TranscriptItem {
		const item: TranscriptItem = { seq: ++this.seq, ts: this.now(), type, payload };
		this.items.push(item);
		if (this.items.length > this.maxItems) {
			const dropped = this.items.shift() as TranscriptItem;
			this.droppedBefore = dropped.seq + 1;
		}
		this.onItem(item, durable);
		return item;
	}
}
