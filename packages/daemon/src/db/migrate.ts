import type { DatabaseSync } from "node:sqlite";

/** Ordered, append-only. The index + 1 is the schema version stored in PRAGMA user_version. */
const MIGRATIONS: string[] = [
	`
	CREATE TABLE projects (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		repo_path TEXT NOT NULL UNIQUE,
		default_branch TEXT NOT NULL,
		setup_command TEXT,
		verify_command TEXT,
		trust_project_pi INTEGER NOT NULL DEFAULT 0,
		extensions_json TEXT NOT NULL DEFAULT '[]',
		concurrency_limit INTEGER NOT NULL DEFAULT 1,
		stage_config_json TEXT NOT NULL DEFAULT '{}',
		created_at INTEGER NOT NULL
	);

	CREATE TABLE cards (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL REFERENCES projects(id),
		title TEXT NOT NULL,
		brief TEXT NOT NULL DEFAULT '',
		stage TEXT NOT NULL DEFAULT 'backlog',
		status TEXT NOT NULL DEFAULT 'idle',
		priority INTEGER NOT NULL DEFAULT 0,
		position REAL NOT NULL DEFAULT 0,
		branch_name TEXT,
		worktree_path TEXT,
		base_commit TEXT,
		attempt INTEGER NOT NULL DEFAULT 0,
		stage_config_json TEXT NOT NULL DEFAULT '{}',
		pr_url TEXT,
		pr_state TEXT,
		needs_attention_reason TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX cards_by_project_stage ON cards(project_id, stage, position);

	-- id doubles as the pi session id, e.g. c<card>-plan-1
	CREATE TABLE stage_runs (
		id TEXT PRIMARY KEY,
		card_id TEXT NOT NULL REFERENCES cards(id),
		kind TEXT NOT NULL,
		stage TEXT NOT NULL,
		attempt INTEGER NOT NULL,
		model TEXT NOT NULL,
		thinking TEXT NOT NULL,
		args_json TEXT NOT NULL DEFAULT '[]',
		status TEXT NOT NULL,
		result_status TEXT,
		result_summary TEXT,
		tokens_json TEXT,
		cost_usd REAL,
		last_entry_id TEXT,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		error TEXT
	);
	CREATE INDEX runs_by_card ON stage_runs(card_id, started_at);

	-- Transcript anchors and card timeline. Never text deltas: those are in-memory only.
	CREATE TABLE events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		card_id TEXT NOT NULL,
		run_id TEXT,
		run_seq INTEGER,
		ts INTEGER NOT NULL,
		type TEXT NOT NULL,
		payload_json TEXT NOT NULL
	);
	CREATE INDEX events_by_run ON events(run_id, run_seq);
	`,
	`
	CREATE TABLE gates (
		id TEXT PRIMARY KEY,
		card_id TEXT NOT NULL REFERENCES cards(id),
		kind TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		feedback TEXT,
		created_at INTEGER NOT NULL,
		decided_at INTEGER
	);
	-- A card waits on at most one human decision at a time.
	CREATE UNIQUE INDEX one_pending_gate ON gates(card_id) WHERE status = 'pending';
	`,
	`
	-- Work a card is waiting to start, persisted so the queue survives a restart.
	ALTER TABLE cards ADD COLUMN queued_effect_json TEXT;
	ALTER TABLE cards ADD COLUMN queued_at INTEGER;
	`,
];

export function migrate(db: DatabaseSync): void {
	const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
	for (let version = current; version < MIGRATIONS.length; version++) {
		db.exec("BEGIN");
		try {
			db.exec(MIGRATIONS[version] as string);
			db.exec(`PRAGMA user_version = ${version + 1}`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}
