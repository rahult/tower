import type { NostrEvent } from "./nostr.ts";

export interface PublishResult {
	id: string;
	ok: boolean;
	message: string;
}

/**
 * Sends events to a Nostr relay (NIP-01) one at a time and collects each OK. Uses the runtime's own WebSocket.
 * Rejects when the relay cannot be reached or stops answering; a relay refusing an event is a result, not an error.
 */
export function publish(url: string, events: NostrEvent[], timeoutMs = 20_000): Promise<PublishResult[]> {
	return new Promise((resolve, reject) => {
		const results: PublishResult[] = [];
		let index = 0;
		const socket = new WebSocket(url);
		let timer: NodeJS.Timeout | undefined;
		let done = false;
		const finish = (error?: Error) => {
			if (done) return; // closing a socket that failed to open fires "error" again
			done = true;
			clearTimeout(timer);
			socket.close();
			if (error) reject(error);
			else resolve(results);
		};
		const sendNext = () => {
			const event = events[index];
			if (!event) return finish();
			clearTimeout(timer);
			timer = setTimeout(() => finish(new Error(`The relay at ${url} did not answer for event ${event.id.slice(0, 8)}`)), timeoutMs);
			socket.send(JSON.stringify(["EVENT", event]));
		};
		socket.addEventListener("open", sendNext);
		socket.addEventListener("error", () => finish(new Error(`Could not reach the relay at ${url}`)));
		socket.addEventListener("message", (message) => {
			let frame: unknown;
			try {
				frame = JSON.parse(String(message.data));
			} catch {
				return;
			}
			if (!Array.isArray(frame) || frame[0] !== "OK" || frame[1] !== events[index]?.id) return;
			results.push({ id: frame[1], ok: frame[2] === true, message: typeof frame[3] === "string" ? frame[3] : "" });
			index += 1;
			sendNext();
		});
	});
}
