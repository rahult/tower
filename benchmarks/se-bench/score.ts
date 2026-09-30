/**
 * Scoring: six software-engineering dimensions, 0–10 each.
 *
 * Correctness is fully programmatic (hidden acceptance tests). Testing blends the produced
 * project's own test suite with the judge's quality read. The other four are judged by the
 * strongest local model against a fixed rubric, with the brief, the files, and the test
 * outcomes in view.
 */
import { chat } from "./lib/ollama.ts";
import { chatRemote, isRemoteModel } from "./lib/openrouter.ts";
import { runAcceptance, runOwnTests, readAllFiles, type TaskDef, type AcceptanceResult, type OwnTestResult } from "./lib/tasks.ts";

export const DIMENSIONS = ["correctness", "spec_compliance", "code_quality", "testing", "robustness", "documentation"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface Scored {
	dimensions: Record<Dimension, number>;
	acceptance: AcceptanceResult | null;
	ownTests: OwnTestResult | null;
	judgeRationale: Record<string, string> | null;
	judgeRawScores: Record<string, number> | null;
}

const RUBRIC = `You are a strict senior engineer reviewing a candidate's implementation of a small specification. Score the work on five dimensions, each 0-10, using these anchors:

- spec_compliance (0-10): 0 = ignores the spec; 5 = roughly half the required behaviour present or visibly wrong in shape; 8 = all major requirements met with minor deviations; 10 = every stated requirement met exactly (naming, formats, edge rules).
- code_quality (0-10): 0 = unreadable; 5 = works but tangled, inconsistent, copy-paste; 8 = clean, idiomatic, small functions, sensible module split; 10 = exemplary structure a team could maintain. Architecture and SOLID weigh heavily in this dimension: single-responsibility modules with clear seams, dependencies pointing in one direction (no circular or inverted imports), substitutable small units, and change-absorbing extension points push the score up; god-objects, leaky boundaries, mixed concerns, dead code, and copy-paste push it down.
- testing_quality (0-10): 0 = no tests; 4 = token tests touching the happy path only; 7 = covers the main behaviours including failure modes; 10 = thorough, precise assertions, tests would catch subtle regressions.
- robustness (0-10): 0 = crashes on ordinary bad input; 5 = handles common edge cases but misses several; 8 = validates inputs, sensible errors, no obvious crash paths; 10 = defensively engineered with clear failure contracts.
- documentation (0-10): 0 = nothing usable; 5 = minimal usage note; 8 = clear README covering usage, formats and behaviours; 10 = complete, precise, matches the implementation.

Judge what is there, not what was promised. Do not be generous: 7 already means genuinely good. If files are missing or the project does not run, score low and say why.`;

export async function scoreRun(task: TaskDef, brief: string, outDir: string, judgeModel: string): Promise<Scored> {
	// Programmatic signals first; a missing outDir is a zero everywhere.
	let acceptance: AcceptanceResult | null = null;
	try {
		acceptance = await runAcceptance(task.id, outDir);
	} catch (error) {
		acceptance = { total: 0, passed: 0, failed: 0, cases: [], raw: `acceptance crashed: ${error instanceof Error ? error.message : String(error)}` };
	}
	const ownTests = await runOwnTests(outDir).catch(() => ({ hasTests: false, passed: false, detail: "own tests crashed", testFileCount: 0 }));

	const correctness = acceptance.total > 0 ? (10 * acceptance.passed) / acceptance.total : 0;

	const files = await readAllFiles(outDir, 8_000);
	const fileBlock = files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n") || "(no files produced)";

	const judgePrompt = `${RUBRIC}

## Task summary
${task.summary}

## Full specification given to the builder
${brief}

## Files produced
${fileBlock}

## Test outcomes
- Hidden acceptance suite (checks the specification's examples and edge rules): ${acceptance ? `${acceptance.passed}/${acceptance.total} cases passed` : "could not run"}
- The builder's own test suite: ${ownTests.detail}

Score the five judged dimensions. Respond as JSON:
{"scores":{"spec_compliance":n,"code_quality":n,"testing_quality":n,"robustness":n,"documentation":n},"rationale":{"spec_compliance":"one sentence","code_quality":"one sentence, explicitly naming architecture/SOLID strengths or failures","testing_quality":"one sentence","robustness":"one sentence","documentation":"one sentence"}}`;

	const judge = isRemoteModel(judgeModel)
		? await chatRemote({
				model: judgeModel,
				messages: [
					// Agentic coding models treat a big review payload as a workspace; pin them to grading.
					{ role: "system", content: "You are a grading engine, not a coding agent. Read the rubric and materials, then output only the single JSON object requested — no prose, no markdown fences, no analysis, no code, no continuation." },
					{ role: "user", content: judgePrompt },
				],
				temperature: 0,
				timeoutMs: 600_000,
			})
		: await chat({
				model: judgeModel,
				messages: [{ role: "user", content: judgePrompt }],
				numCtx: 16384,
				temperature: 0,
				json: true,
				timeoutMs: 600_000,
			});

	let judgeRawScores: Record<string, number> | null = null;
	let judgeRationale: Record<string, string> | null = null;
	try {
		const parsed = JSON.parse(extractJson(judge.content)) as { scores?: Record<string, number>; rationale?: Record<string, string> };
		judgeRawScores = Object.fromEntries(Object.entries(parsed.scores ?? {}).map(([k, v]) => [k, Number(v)]));
		judgeRationale = parsed.rationale ?? null;
	} catch {
		judgeRationale = { parse: `judge returned unparseable JSON: ${judge.content.slice(0, 200)}` };
	}	const clamp = (n: number) => Math.max(0, Math.min(10, Math.round(n * 10) / 10));
	const judgeScore = (key: string, fallback: number) => (judgeRawScores && Number.isFinite(judgeRawScores[key]) ? clamp(judgeRawScores[key]) : fallback);
	const testingProgrammatic = ownTests.hasTests && ownTests.passed ? 10 : ownTests.hasTests ? 4 : 0;
	const testing = 0.6 * testingProgrammatic + 0.4 * judgeScore("testing_quality", 0);

	return {
		dimensions: {
			correctness: clamp(correctness),
			spec_compliance: judgeScore("spec_compliance", 0),
			code_quality: judgeScore("code_quality", 0),
			testing: clamp(testing),
			robustness: judgeScore("robustness", 0),
			documentation: judgeScore("documentation", 0),
		},
		acceptance,
		ownTests,
		judgeRationale,
		judgeRawScores,
	};
}

/** Strict JSON.parse, then a fallback that pulls the outermost {...} block out of prose (some remote models preface their JSON). */
function extractJson(content: string): string {
	try {
		JSON.parse(content);
		return content;
	} catch {
		const start = content.indexOf("{");
		const end = content.lastIndexOf("}");
		if (start === -1 || end <= start) throw new Error("no JSON object in judge output");
		return content.slice(start, end + 1);
	}
}
