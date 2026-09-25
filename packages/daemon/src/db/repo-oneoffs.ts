import type { Db } from "./open.ts";

export interface OneoffRun {
	id: string;
	kind: string;
	model: string;
	tokensJson: string | null;
	costUsd: number | null;
	startedAt: number;
}

/** Records a card-less model session so its spend shows up in Usage next to everything else's. */
export function insertOneoffRun(db: Db, run: OneoffRun): void {
	db.prepare("INSERT INTO oneoff_runs (id, kind, model, tokens_json, cost_usd, started_at) VALUES (?, ?, ?, ?, ?, ?)").run(
		run.id,
		run.kind,
		run.model,
		run.tokensJson,
		run.costUsd,
		run.startedAt,
	);
}
