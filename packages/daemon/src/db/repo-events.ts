import type { Db } from "./open.ts";

export interface StoredItem {
	seq: number;
	ts: number;
	type: string;
	payload: unknown;
}

/** Persists one transcript anchor for a run. */
export function insertRunEvent(db: Db, cardId: string, runId: string, item: StoredItem): void {
	db.prepare("INSERT INTO events (card_id, run_id, run_seq, ts, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(
		cardId,
		runId,
		item.seq,
		item.ts,
		item.type,
		JSON.stringify(item.payload),
	);
}

export function listRunEvents(db: Db, runId: string, sinceSeq = 0): StoredItem[] {
	const rows = db
		.prepare("SELECT run_seq, ts, type, payload_json FROM events WHERE run_id = ? AND run_seq > ? ORDER BY run_seq")
		.all(runId, sinceSeq) as Array<{ run_seq: number; ts: number; type: string; payload_json: string }>;
	return rows.map((row) => ({ seq: row.run_seq, ts: row.ts, type: row.type, payload: JSON.parse(row.payload_json) }));
}

export function lastRunSeq(db: Db, runId: string): number {
	return (db.prepare("SELECT coalesce(max(run_seq), 0) AS seq FROM events WHERE run_id = ?").get(runId) as { seq: number }).seq;
}
