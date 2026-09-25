import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { applyItem, type Block, type TranscriptItem } from "../card/transcript-model.ts";

/**
 * Transcript state lives outside React: a streaming response is a firehose, and pushing every frame through
 * component state would re-render the tree per frame. Components subscribe with useSyncExternalStore instead.
 */
class TranscriptStore {
	private blocks: Block[] = [];
	lastSeq = 0;
	private readonly listeners = new Set<() => void>();

	apply(item: TranscriptItem): void {
		// EventSource reconnects resume via Last-Event-ID, but guard anyway so a replay can never double-apply.
		if (item.seq <= this.lastSeq) return;
		this.lastSeq = item.seq;
		const next = applyItem(this.blocks, item);
		if (next === this.blocks) return;
		this.blocks = next;
		for (const listener of this.listeners) listener();
	}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	snapshot = () => this.blocks;
}

const stores = new Map<string, TranscriptStore>();
const storeFor = (runId: string) => {
	let store = stores.get(runId);
	if (!store) stores.set(runId, (store = new TranscriptStore()));
	return store;
};

/** Whether the board is hearing from the daemon. Shown in the status bar, because a silent board must not look calm. */
export type Connection = "connecting" | "live" | "reconnecting";
let connection: Connection = "connecting";
const connectionListeners = new Set<() => void>();
function setConnection(next: Connection): void {
	if (next === connection) return;
	connection = next;
	for (const listener of connectionListeners) listener();
}
export function useConnection(): Connection {
	return useSyncExternalStore(
		(listener) => {
			connectionListeners.add(listener);
			return () => connectionListeners.delete(listener);
		},
		() => connection,
	);
}

const EMPTY: Block[] = [];

export function useTranscript(runId: string | null): Block[] {
	const store = runId ? storeFor(runId) : null;
	return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? (() => EMPTY));
}
const noSubscribe = () => () => {};

/** One multiplexed SSE connection per tab: board changes plus the transcript of the run that is open. */
export function useEventStream(openRunId: string | null): void {
	const queryClient = useQueryClient();
	useEffect(() => {
		// Keep the run's store across reconnects and re-opens: components are already subscribed to that object.
		// Resuming from its last seq means only unseen items are sent, and the store drops any duplicate anyway.
		const topics = openRunId ? `board,run:${openRunId}` : "board";
		const since = openRunId ? storeFor(openRunId).lastSeq : 0;
		const source = new EventSource(`/api/stream?topics=${topics}&since=${since}`);
		// Board frames carry no replay cursor, so refetch whenever the connection (re)opens.
		source.onopen = () => {
			setConnection("live");
			void queryClient.invalidateQueries();
		};
		// EventSource retries by itself; until it is back, say so.
		source.onerror = () => setConnection("reconnecting");
		source.onmessage = (message) => {
			const frame = JSON.parse(message.data) as { topic: string; type: string; data: any };
			if (frame.topic === "board") {
				void queryClient.invalidateQueries({ queryKey: ["board"] });
				if (frame.type === "settings_changed") void queryClient.invalidateQueries({ queryKey: ["settings"] });
				const cardId = frame.data?.cardId ?? (frame.type === "card_upserted" || frame.type === "card_deleted" ? frame.data?.id : null);
				if (cardId) void queryClient.invalidateQueries({ queryKey: ["card", cardId] });
			} else if (frame.topic.startsWith("run:")) {
				storeFor(frame.topic.slice(4)).apply(frame.type === "gap" ? { seq: 0.5, ts: 0, type: "gap", payload: frame.data } : frame.data);
			}
		};
		return () => source.close();
	}, [openRunId, queryClient]);
}
