export interface BusEvent {
	/** "board" or "run:<runId>". */
	topic: string;
	type: string;
	data: unknown;
	/** Present on run items; lets SSE clients resume with Last-Event-ID. */
	seq?: number;
}

type Listener = (event: BusEvent) => void;

/** In-process pub/sub between the run machinery and SSE connections. */
export class Bus {
	private readonly listeners = new Set<Listener>();

	publish(event: BusEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
