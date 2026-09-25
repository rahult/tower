import type { Card, Effect } from "@tower/core";
import type { Db } from "./open.ts";

type Row = Record<string, string | number | null>;

function toCard(row: Row): Card {
	return {
		id: row.id as string,
		projectId: row.project_id as string,
		title: row.title as string,
		brief: row.brief as string,
		stage: row.stage as Card["stage"],
		status: row.status as Card["status"],
		priority: row.priority as number,
		position: row.position as number,
		branchName: row.branch_name as string | null,
		worktreePath: row.worktree_path as string | null,
		baseCommit: row.base_commit as string | null,
		attempt: row.attempt as number,
		stageConfig: JSON.parse(row.stage_config_json as string),
		prUrl: row.pr_url as string | null,
		prState: row.pr_state as string | null,
		needsAttentionReason: row.needs_attention_reason as string | null,
		finishNote: row.finish_note as string | null,
		issueUrl: row.issue_url as string | null,
		issueNumber: row.issue_number as number | null,
		issueAuthor: row.issue_author as string | null,
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

export function insertCard(db: Db, card: Card): void {
	db.prepare(
		`INSERT INTO cards (id, project_id, title, brief, stage, status, priority, position, attempt, stage_config_json, created_at, updated_at, issue_url, issue_number, issue_author)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		card.id,
		card.projectId,
		card.title,
		card.brief,
		card.stage,
		card.status,
		card.priority,
		card.position,
		card.attempt,
		JSON.stringify(card.stageConfig),
		card.createdAt,
		card.updatedAt,
		card.issueUrl,
		card.issueNumber,
		card.issueAuthor,
	);
}

const COLUMNS = {
	stage: "stage",
	status: "status",
	attempt: "attempt",
	branchName: "branch_name",
	worktreePath: "worktree_path",
	baseCommit: "base_commit",
	needsAttentionReason: "needs_attention_reason",
	finishNote: "finish_note",
	prUrl: "pr_url",
	prState: "pr_state",
	issueUrl: "issue_url",
	issueNumber: "issue_number",
	issueAuthor: "issue_author",
} as const;

export type CardPatch = Partial<Pick<Card, keyof typeof COLUMNS>>;

export function updateCard(db: Db, id: string, patch: CardPatch): Card {
	const keys = Object.keys(patch) as Array<keyof typeof COLUMNS>;
	const sets = [...keys.map((key) => `${COLUMNS[key]} = ?`), "updated_at = ?"];
	const values = [...keys.map((key) => patch[key] ?? null), Date.now(), id];
	db.prepare(`UPDATE cards SET ${sets.join(", ")} WHERE id = ?`).run(...values);
	const card = getCard(db, id);
	if (!card) throw new Error(`Card not found: ${id}`);
	return card;
}

export function listCards(db: Db): Card[] {
	return (db.prepare("SELECT * FROM cards ORDER BY position, created_at").all() as Row[]).map(toCard);
}

export function getCard(db: Db, id: string): Card | null {
	const row = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as Row | undefined;
	return row ? toCard(row) : null;
}

/** The card an issue was intake'd into, or null when the issue has never been seen. */
export function getCardByIssue(db: Db, issueNumber: number): Card | null {
	const row = db.prepare("SELECT * FROM cards WHERE issue_number = ? ORDER BY created_at LIMIT 1").get(issueNumber) as Row | undefined;
	return row ? toCard(row) : null;
}

export interface QueuedCard {
	card: Card;
	effect: Effect;
	queuedAt: number;
}

export function setQueuedEffect(db: Db, id: string, effect: Effect | null): void {
	db.prepare("UPDATE cards SET queued_effect_json = ?, queued_at = ? WHERE id = ?").run(effect ? JSON.stringify(effect) : null, effect ? Date.now() : null, id);
}

export function listQueued(db: Db): QueuedCard[] {
	const rows = db.prepare("SELECT * FROM cards WHERE queued_effect_json IS NOT NULL ORDER BY queued_at").all() as Row[];
	return rows.map((row) => ({ card: toCard(row), effect: JSON.parse(row.queued_effect_json as string), queuedAt: row.queued_at as number }));
}

/** Cards whose work is actually executing (not merely waiting for a slot). */
export function listExecuting(db: Db): Card[] {
	return (db.prepare("SELECT * FROM cards WHERE status IN ('running', 'verifying') AND queued_effect_json IS NULL").all() as Row[]).map(toCard);
}

/** Cards whose pull request is open and being watched. */
export function listWatchedPullRequests(db: Db): Card[] {
	return (db.prepare("SELECT * FROM cards WHERE stage = 'pull_request' AND status = 'idle' AND pr_url IS NOT NULL").all() as Row[]).map(toCard);
}
