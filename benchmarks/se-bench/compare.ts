/**
 * Head-to-head code comparison: two produced implementations of the same task, one judge.
 *
 *   node compare.ts <taskId> <judgeModel> <dirA> <labelA> <dirB> <labelB>
 *
 * Emits markdown to stdout: per-dimension scores for A and B with cited evidence, then a
 * dimension-by-dimension verdict. The judge sees both file sets plus the brief and both
 * test outcomes, and must cite concrete file-level evidence for every claim.
 */
import { TASKS, readBrief, readAllFiles, runAcceptance, runOwnTests } from "./lib/tasks.ts";
import { chatRemote, isRemoteModel } from "./lib/openrouter.ts";
import { chat } from "./lib/ollama.ts";

const [taskId, judgeModel, dirA, labelA, dirB, labelB] = process.argv.slice(2);
const task = TASKS.find((t) => t.id === taskId);
if (!task || !judgeModel || !dirA || !dirB) throw new Error("usage: node compare.ts <taskId> <judgeModel> <dirA> <labelA> <dirB> <labelB>");

const brief = await readBrief(taskId);
const bundle = async (dir: string, label: string) => {
	const files = await readAllFiles(dir, 12_000);
	const acc = await runAcceptance(taskId, dir).catch(() => null);
	const own = await runOwnTests(dir).catch(() => null);
	return `## Implementation ${label}
Directory: ${dir}
Files: ${files.map((f) => f.path).join(", ") || "(none)"}
Hidden acceptance: ${acc ? `${acc.passed}/${acc.total}` : "could not run"}
Own tests: ${own?.detail ?? "?"}

${files.map((f) => `=== ${label}/${f.path} ===\n${f.content}`).join("\n\n") || "(no files)"}`;
};

const prompt = `You are a strict senior engineer doing a head-to-head review of TWO implementations of the SAME small specification, built independently. Compare them on software design quality.

## The specification
${brief}

${await bundle(dirA, labelA)}

${await bundle(dirB, labelB)}

## Your task
Compare ${labelA} vs ${labelB} dimension by dimension. For each dimension give both a score (0-10, 7 = genuinely good) AND one or two sentences of concrete evidence (name files, functions, or test cases — no generic praise). Dimensions:
- architecture: module split, seams, dependency direction, extension points
- solid: single-responsibility units, substitutability, interface boundaries, absence of god-objects
- robustness: input validation, error contracts, edge-case behaviour
- testing: coverage of failure modes, assertion precision, would-the-tests-catch-regressions
- documentation: accuracy against the code, completeness for a new user

Then an overall verdict: which implementation is better engineered and why, the margin (decisive / clear / slight), and the single most important difference. Be strict and specific; if one implementation is empty or broken, say so plainly.

Respond as JSON only:
{"dimensions":{"architecture":{"a":n,"b":n,"evidence":"…"},"solid":{"a":n,"b":n,"evidence":"…"},"robustness":{"a":n,"b":n,"evidence":"…"},"testing":{"a":n,"b":n,"evidence":"…"},"documentation":{"a":n,"b":n,"evidence":"…"}},"verdict":{"winner":"${labelA}"|"${labelB}"|"tie","margin":"decisive|clear|slight","summary":"two sentences","key_difference":"one sentence"}}`;

const judge = isRemoteModel(judgeModel)
	? await chatRemote({ model: judgeModel, messages: [{ role: "user", content: prompt }], temperature: Number(process.env.BENCH_JUDGE_TEMPERATURE ?? 0), timeoutMs: 600_000 })
	: await chat({ model: judgeModel, messages: [{ role: "user", content: prompt }], numCtx: 32768, temperature: 0, json: true, timeoutMs: 600_000 });

let parsed: any;
try {
	const start = judge.content.indexOf("{");
	const end = judge.content.lastIndexOf("}");
	parsed = JSON.parse(judge.content.slice(start, end + 1));
} catch {
	console.log(` Judge returned unparseable output:\n${judge.content.slice(0, 500)}`);
	process.exit(1);
}

const D = parsed.dimensions ?? {};
console.log(`### ${task.title} — ${labelA} vs ${labelB}\n`);
console.log(`| Dimension | ${labelA} | ${labelB} | Evidence |`);
console.log(`| --- | --- | --- | --- |`);
for (const [dim, v] of Object.entries(D)) {
	console.log(`| ${dim} | ${(v as any).a} | ${(v as any).b} | ${String((v as any).evidence).replace(/\|/g, "\\|")} |`);
}
const v = parsed.verdict ?? {};
console.log(`\n**Verdict: ${v.winner} (${v.margin ?? "?"})** — ${v.summary ?? ""}`);
console.log(`\nKey difference: ${v.key_difference ?? "?"}`);
