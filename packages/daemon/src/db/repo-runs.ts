import type { StageRun } from "@tower/core";
import type { Db } from "./open.ts";

type Row = Record<string, string | number | null>;

function toRun(row: Row): StageRun {
	return {
		id: row.id as string,
		cardId: row.card_id as string,
		kind: row.kind as StageRun["kind"],
		stage: row.stage as StageRun["stage"],
		attempt: row.attempt as number,
		model: row.model as string,
		thinking: row.thinking as StageRun["thinking"],
		args: JSON.parse(row.args_json as string),
		status: row.status as StageRun["status"],
		resultStatus: row.result_status as StageRun["resultStatus"],
		resultSummary: row.result_summary as string | null,
		questions: row.questions_json ? JSON.parse(row.questions_json as string) : null,
		tokens: row.tokens_json ? JSON.parse(row.tokens_json as string) : null,
		costUsd: row.cost_usd as number | null,
		lastEntryId: row.last_entry_id as string | null,
		startedAt: row.started_at as number,
		endedAt: row.ended_at as number | null,
		error: row.error as string | null,
	};
}

export function insertRun(db: Db, run: StageRun): void {
	db.prepare(
		`INSERT INTO stage_runs (id, card_id, kind, stage, attempt, model, thinking, args_json, status, started_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(run.id, run.cardId, run.kind, run.stage, run.attempt, run.model, run.thinking, JSON.stringify(run.args), run.status, run.startedAt);
}

const COLUMNS = {
	status: "status",
	resultStatus: "result_status",
	resultSummary: "result_summary",
	costUsd: "cost_usd",
	lastEntryId: "last_entry_id",
	endedAt: "ended_at",
	error: "error",
} as const;

export type RunPatch = Partial<Pick<StageRun, keyof typeof COLUMNS | "tokens" | "questions">>;

export function updateRun(db: Db, id: string, patch: RunPatch): void {
	const { tokens, questions, ...rest } = patch;
	const keys = Object.keys(rest) as Array<keyof typeof COLUMNS>;
	const sets = keys.map((key) => `${COLUMNS[key]} = ?`);
	const values: Array<string | number | null> = keys.map((key) => rest[key] ?? null);
	if (tokens !== undefined) {
		sets.push("tokens_json = ?");
		values.push(tokens ? JSON.stringify(tokens) : null);
	}
	if (questions !== undefined) {
		sets.push("questions_json = ?");
		values.push(questions ? JSON.stringify(questions) : null);
	}
	if (sets.length === 0) return;
	db.prepare(`UPDATE stage_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
}

export function getRun(db: Db, id: string): StageRun | null {
	const row = db.prepare("SELECT * FROM stage_runs WHERE id = ?").get(id) as Row | undefined;
	return row ? toRun(row) : null;
}

export function listRunsForCard(db: Db, cardId: string): StageRun[] {
	return (db.prepare("SELECT * FROM stage_runs WHERE card_id = ? ORDER BY started_at").all(cardId) as Row[]).map(toRun);
}

export function listActiveRuns(db: Db): StageRun[] {
	return (db.prepare("SELECT * FROM stage_runs WHERE status IN ('starting', 'running')").all() as Row[]).map(toRun);
}

export function countRunsForStage(db: Db, cardId: string, stage: string): number {
	return (db.prepare("SELECT count(*) AS n FROM stage_runs WHERE card_id = ? AND stage = ?").get(cardId, stage) as { n: number }).n;
}

export function lastRunForCard(db: Db, cardId: string): StageRun | null {
	const row = db.prepare("SELECT * FROM stage_runs WHERE card_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(cardId) as Row | undefined;
	return row ? toRun(row) : null;
}

/** Marks every run the previous daemon process left in flight. Returns how many there were. */
export function interruptActiveRuns(db: Db): number {
	return Number(db.prepare("UPDATE stage_runs SET status = 'interrupted', ended_at = ? WHERE status IN ('starting', 'running')").run(Date.now()).changes);
}
