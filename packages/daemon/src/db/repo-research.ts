import type { ResearchQuestion } from "@tower/core";
import type { Db } from "./open.ts";

type Row = Record<string, string | number | null>;

const toQuestion = (row: Row): ResearchQuestion => ({
	id: row.id as string,
	question: row.question as string,
	status: row.status as ResearchQuestion["status"],
	step: (row.step as ResearchQuestion["step"]) ?? null,
	brief: row.brief as string | null,
	promotedCardId: row.promoted_card_id as string | null,
	promotedProjectId: row.promoted_project_id as string | null,
	createdAt: row.created_at as number,
});

export function insertQuestion(db: Db, id: string, question: string, createdAt: number): ResearchQuestion {
	db.prepare("INSERT INTO research_questions (id, question, status, created_at) VALUES (?, ?, 'running', ?)").run(id, question, createdAt);
	return getQuestion(db, id) as ResearchQuestion;
}

export function getQuestion(db: Db, id: string): ResearchQuestion | null {
	const row = db.prepare("SELECT * FROM research_questions WHERE id = ?").get(id) as Row | undefined;
	return row ? toQuestion(row) : null;
}

export function listQuestions(db: Db): ResearchQuestion[] {
	return (db.prepare("SELECT * FROM research_questions ORDER BY created_at DESC").all() as Row[]).map(toQuestion);
}

export function setQuestionStatus(db: Db, id: string, status: ResearchQuestion["status"]): void {
	db.prepare("UPDATE research_questions SET status = ? WHERE id = ?").run(status, id);
}

export function setQuestionStep(db: Db, id: string, step: ResearchQuestion["step"]): void {
	db.prepare("UPDATE research_questions SET step = ? WHERE id = ?").run(step, id);
}

/** Stops a run in its tracks: back to open, no step in flight. */
export function resetQuestionRun(db: Db, id: string): void {
	db.prepare("UPDATE research_questions SET status = 'open', step = NULL WHERE id = ?").run(id);
}

export function setQuestionBrief(db: Db, id: string, brief: string): void {
	db.prepare("UPDATE research_questions SET brief = ?, status = 'brief', step = NULL WHERE id = ?").run(brief, id);
}

export function markQuestionPromoted(db: Db, id: string, cardId: string, projectId: string): void {
	db.prepare("UPDATE research_questions SET status = 'promoted', promoted_card_id = ?, promoted_project_id = ? WHERE id = ?").run(cardId, projectId, id);
}
