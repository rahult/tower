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
	`
	-- What a stage asked a person, when it stopped to ask.
	ALTER TABLE stage_runs ADD COLUMN questions_json TEXT;
	`,
	`
	-- Review flows a project runs after its tests pass. NULL means Tower's default set.
	ALTER TABLE projects ADD COLUMN review_flows_json TEXT;
	`,
	`
	-- Invariant simulation in planning and testing. NULL means Tower's default.
	ALTER TABLE projects ADD COLUMN invariant_simulation INTEGER;
	`,
	`
	-- Hands-on commands, run from a card on a person's say-so: tests and a dev-server preview.
	ALTER TABLE projects ADD COLUMN test_command TEXT;
	ALTER TABLE projects ADD COLUMN preview_command TEXT;
	ALTER TABLE projects ADD COLUMN preview_url TEXT;
	`,
	`
	-- Parallel sub-agents: scouts and stream crews fanned out from the plan. NULL means Tower's default.
	ALTER TABLE projects ADD COLUMN subagents INTEGER;
	`,
	`
	-- Probed from the repository: with an origin remote cards finish as pull requests, without one Tower merges locally.
	ALTER TABLE projects ADD COLUMN has_origin INTEGER;
	`,
	`
	-- Where a card came from: a GitHub issue on the feedback repo (intake), or nothing (made on this board).
	ALTER TABLE cards ADD COLUMN issue_url TEXT;
	ALTER TABLE cards ADD COLUMN issue_number INTEGER;
	ALTER TABLE cards ADD COLUMN issue_author TEXT;
	`,
	`
	-- Understand the system before planning (per-project system model), and acceptance gates that turn a
	-- plan's test targets into failing tests before building and passing ones after. NULL means Tower's default.
	ALTER TABLE projects ADD COLUMN understand_before_plan INTEGER;
	ALTER TABLE projects ADD COLUMN acceptance_gates INTEGER;
	`,
	`
	-- Run after a preview starts, so a URL that is really somebody else's app is reported degraded, not trusted.
	ALTER TABLE projects ADD COLUMN preview_check TEXT;
	`,
	`
	-- A done card's parting words (merged locally, PR merged) are an outcome, not an attention reason.
	ALTER TABLE cards ADD COLUMN finish_note TEXT;
	`,
	`
	-- The most one card may spend on agent sessions before the pipeline pauses for a person. NULL: unbudgeted.
	ALTER TABLE projects ADD COLUMN budget_usd REAL;
	`,
	`
	-- Run the after-tests review flows at the same time instead of one after another. NULL: Tower's default (sequential).
	ALTER TABLE projects ADD COLUMN parallel_reviews INTEGER;
	`,
	`
	-- Card-less model sessions (the ask box's intent reader, command suggestions, model checks) so
	-- their spend is visible in Usage like everything else's.
	CREATE TABLE oneoff_runs (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		model TEXT NOT NULL,
		tokens_json TEXT,
		cost_usd REAL,
		started_at INTEGER NOT NULL
	);
	`,
];

/** The schema version a fully migrated database carries (PRAGMA user_version). */
export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: DatabaseSync): void {
	const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
	// A real upgrade (not a fresh database) is worth announcing: it is the moment an update touches live data.
	if (current > 0 && current < MIGRATIONS.length) console.log(`database: applying ${MIGRATIONS.length - current} migration${MIGRATIONS.length - current === 1 ? "" : "s"} (version ${current} → ${MIGRATIONS.length})`);
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
