import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunManager } from "../run/run-manager.ts";
import type { Bus, BusEvent } from "./bus.ts";

const HEARTBEAT_MS = 15_000;

/**
 * One multiplexed stream per tab: GET /api/stream?topics=board,run:<id>&since=<seq>
 *
 * Run items carry `id: run:<runId>:<seq>`, so a dropped connection resumes exactly via Last-Event-ID.
 * Board events carry no id; clients refetch the board on (re)connect instead.
 */
export function handleStream(c: Context, bus: Bus, runs: RunManager): Response {
	const topics = new Set((c.req.query("topics") ?? "board").split(",").filter(Boolean));
	const resume = parseResume(c.req.header("Last-Event-ID"));
	const sinceParam = Number(c.req.query("since") ?? 0);

	return streamSSE(c, async (stream) => {
		const queue: BusEvent[] = [];
		let wake: (() => void) | null = null;
		let open = true;

		const write = (event: BusEvent) =>
			stream.writeSSE({
				data: JSON.stringify({ topic: event.topic, type: event.type, data: event.data }),
				...(event.seq !== undefined ? { id: `${event.topic}:${event.seq}` } : {}),
			});

		// Subscribe and take every snapshot in one synchronous step (no await in between): each item is then in
		// exactly one of `replay` or `queue`, so there are no gaps and no duplicates by construction.
		const unsubscribe = bus.subscribe((event) => {
			if (!topics.has(event.topic)) return;
			queue.push(event);
			wake?.();
		});
		const replay: BusEvent[] = [];
		for (const topic of topics) {
			if (!topic.startsWith("run:")) continue;
			const since = resume?.topic === topic ? resume.seq : sinceParam;
			const snapshot = runs.transcript(topic.slice(4), since);
			if (snapshot.droppedBefore > since + 1) replay.push({ topic, type: "gap", data: { droppedBefore: snapshot.droppedBefore } });
			for (const item of snapshot.items) replay.push({ topic, type: item.type, data: item, seq: item.seq });
		}
		stream.onAbort(() => {
			open = false;
			unsubscribe();
			wake?.();
		});
		for (const event of replay) await write(event);

		while (open) {
			while (queue.length > 0 && open) {
				await write(queue.shift() as BusEvent);
			}
			if (!open) break;
			const timedOut = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(true), HEARTBEAT_MS);
				wake = () => {
					clearTimeout(timer);
					resolve(false);
				};
			});
			wake = null;
			if (timedOut && open) await stream.writeSSE({ event: "ping", data: "" });
		}
	});
}

function parseResume(header: string | undefined): { topic: string; seq: number } | null {
	const match = header?.match(/^(run:.+):(\d+)$/);
	return match ? { topic: match[1] as string, seq: Number(match[2]) } : null;
}
