/** Something a stage needs a person to decide. Options make it answerable with a click; the first is the agent's suggestion. */
export interface Question {
	question: string;
	options: string[];
}

export interface StageResult {
	status: "pass" | "fail" | "blocked";
	summary: string;
	/** Only on a blocked stage that asked something specific. */
	questions?: Question[];
}

const MAX_QUESTIONS = 6;
const MAX_OPTIONS = 6;

/** Keeps the well-formed questions and drops the rest: a malformed one must not cost the person the others. */
function parseQuestions(input: unknown): Question[] {
	if (!Array.isArray(input)) return [];
	const questions: Question[] = [];
	for (const item of input) {
		if (typeof item !== "object" || item === null) continue;
		const { question, options } = item as { question?: unknown; options?: unknown };
		if (typeof question !== "string" || question.trim() === "") continue;
		const cleaned = Array.isArray(options) ? options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim()) : [];
		questions.push({ question: question.trim(), options: cleaned.slice(0, MAX_OPTIONS) });
	}
	return questions.slice(0, MAX_QUESTIONS);
}

export type ParsedStageResult = { ok: true; result: StageResult } | { ok: false; reason: string };

const STATUSES = new Set(["pass", "fail", "blocked"]);

/** Parses the stage-result.json an agent writes at the end of a stage. `raw` is null when the file is missing. */
export function parseStageResult(raw: string | null): ParsedStageResult {
	if (raw === null) return { ok: false, reason: "stage-result.json was not written" };
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "stage-result.json is not valid JSON" };
	}
	if (typeof value !== "object" || value === null) return { ok: false, reason: "stage-result.json is not an object" };
	const { status, summary, questions } = value as Record<string, unknown>;
	if (typeof status !== "string" || !STATUSES.has(status)) {
		return { ok: false, reason: `stage-result.json has invalid status: ${JSON.stringify(status)}` };
	}
	const asked = status === "blocked" ? parseQuestions(questions) : [];
	return {
		ok: true,
		result: { status: status as StageResult["status"], summary: typeof summary === "string" ? summary : "", ...(asked.length > 0 ? { questions: asked } : {}) },
	};
}
