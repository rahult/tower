export interface StageResult {
	status: "pass" | "fail" | "blocked";
	summary: string;
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
	const { status, summary } = value as Record<string, unknown>;
	if (typeof status !== "string" || !STATUSES.has(status)) {
		return { ok: false, reason: `stage-result.json has invalid status: ${JSON.stringify(status)}` };
	}
	return { ok: true, result: { status: status as StageResult["status"], summary: typeof summary === "string" ? summary : "" } };
}
