import type { GateKind } from "@traffic-control/core";
import type { Db } from "./open.ts";

export interface Gate {
	id: string;
	cardId: string;
	kind: GateKind;
	status: "pending" | "approved" | "rejected";
	feedback: string | null;
	createdAt: number;
	decidedAt: number | null;
}

type Row = Record<string, string | number | null>;

const toGate = (row: Row): Gate => ({
	id: row.id as string,
	cardId: row.card_id as string,
	kind: row.kind as GateKind,
	status: row.status as Gate["status"],
	feedback: row.feedback as string | null,
	createdAt: row.created_at as number,
	decidedAt: row.decided_at as number | null,
});

export function insertGate(db: Db, gate: Pick<Gate, "id" | "cardId" | "kind" | "createdAt">): void {
	db.prepare("INSERT INTO gates (id, card_id, kind, created_at) VALUES (?, ?, ?, ?)").run(gate.id, gate.cardId, gate.kind, gate.createdAt);
}

export function getGate(db: Db, id: string): Gate | null {
	const row = db.prepare("SELECT * FROM gates WHERE id = ?").get(id) as Row | undefined;
	return row ? toGate(row) : null;
}

export function decideGate(db: Db, id: string, status: "approved" | "rejected", feedback: string | null): void {
	db.prepare("UPDATE gates SET status = ?, feedback = ?, decided_at = ? WHERE id = ?").run(status, feedback, Date.now(), id);
}

export function listGatesForCard(db: Db, cardId: string): Gate[] {
	return (db.prepare("SELECT * FROM gates WHERE card_id = ? ORDER BY created_at").all(cardId) as Row[]).map(toGate);
}
