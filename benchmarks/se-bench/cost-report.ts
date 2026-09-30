/**
 * Real-cost ledger for every scored cell: per task × arm × model, with cache hit/miss splits.
 *
 *   node cost-report.ts            # prints markdown, writes cost-report.md
 *
 * Cost sources, in order of preference:
 * 1. Per-call `cost $X` recorded by the retry proxy from the provider (OpenRouter passthrough) — real money.
 * 2. Provider rate card × per-call token counts (DeepSeek native; cache-hit priced separately).
 * 3. Sibling-cell average per-call cost, flagged `~` (cells run before per-call telemetry existed).
 * Judge/comparison calls are a separate estimated line (token counts are logged, dollars are pennies).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { TASKS } from "./lib/tasks.ts";

const PIN_OFFPEAK = 0.15 / 1e6; // deepseek-flash input, cache miss, off-peak
const PCACHE = 0.003 / 1e6; // deepseek-flash cache hit
const POUT_OFFPEAK = 0.6 / 1e6; // deepseek-flash output, off-peak

interface CellCost {
	arm: string;
	task: string;
	model: string;
	wallMin: number;
	calls: number;
	prompt: number;
	cached: number;
	completion: number;
	/** True when every call carried a provider-reported cost. */
	exact: boolean;
	/** False for cells run before cached-token telemetry existed. */
	hasCacheInfo: boolean;
	isFree: boolean;
	providerCost: number;
	estimated: number;
}

const state = JSON.parse(await readFile(new URL("./.state/state.json", import.meta.url), "utf8"));
const cells: CellCost[] = [];
for (const [id, r] of Object.entries<any>(state.runs)) {
	if (r.status !== "done" || !r.score) continue;
	const [arm, model, task] = [r.arm, r.model, r.task];
	const logName = `${arm}-${model.replace(/[^a-z0-9.]+/gi, "-")}-${task}`;
	let log = "";
	try {
		log = await readFile(new URL(`./.state/logs/${logName}.log`, import.meta.url), "utf8");
	} catch {
		continue;
	}
	const usages = [...log.matchAll(/usage: (\d+) prompt(?: \((\d+) cached\))? \+ (\d+) completion(?:, cost \$([\d.e-]+))?/g)];
	const statusCalls = (log.match(/openrouter-proxy -> 200/g) ?? []).length;
	const calls = usages.length || statusCalls;
	const prompt = usages.reduce((a, m) => a + Number(m[1]), 0);
	const cached = usages.reduce((a, m) => a + Number(m[2] ?? 0), 0);
	const completion = usages.reduce((a, m) => a + Number(m[3]), 0);
	const providerCost = usages.reduce((a, m) => a + Number(m[4] ?? 0), 0);
	const hasCost = usages.length > 0 && usages.every((m) => m[4] !== undefined && Number(m[4]) > 0);
	const hasCacheInfo = usages.some((m) => m[2] !== undefined);
	const isFree = model.endsWith(":free");
	const isDeepseek = model.includes("deepseek");
	const estimated = isDeepseek && calls > 0 ? (prompt - cached) * PIN_OFFPEAK + cached * PCACHE + completion * POUT_OFFPEAK : 0;
	cells.push({
		arm,
		task,
		model: model.replace("openrouter/", ""),
		wallMin: Math.round(((r.endedAt - r.startedAt) / 60000) * 10) / 10,
		calls,
		prompt,
		cached,
		completion,
		exact: hasCost,
		hasCacheInfo,
		isFree,
		providerCost,
		estimated,
	});
}

// Cells run before per-call telemetry: estimate from the exact siblings of the same model+arm.
const fmt = (n: number) => "$" + n.toFixed(3);
const lines: string[] = [];
lines.push("# Cost report — real per-task spend with cache breakdown\n");
lines.push(`Generated ${new Date().toISOString().slice(0, 10)}. DeepSeek cells priced at off-peak rates (input $0.15/M miss · $0.003/M cache hit · output $0.60/M); peak hours (01–04, 06–10 UTC Mon–Fri) would double the miss/output figures. OpenRouter cells use the provider-reported per-call cost where present.\n`);

const modelGroups = [...new Set(cells.map((c) => c.model))];
const totals = new Map<string, number>();
let grand = 0;
for (const model of modelGroups) {
	const group = cells.filter((c) => c.model === model).sort((a, b) => a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm));
	lines.push(`## ${model}\n`);
	lines.push("| Task | Arm | Wall | Calls | Prompt tok | Cached (hit%) | Completion tok | Cost | Basis |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	let modelTotal = 0;
	for (const c of group) {
		let cost: number;
		let basis: string;
		if (c.isFree) {
			cost = 0;
			basis = "free tier ($0)";
		} else if (c.exact) {
			cost = c.providerCost;
			basis = "provider-reported";
		} else if (c.estimated > 0) {
			cost = c.estimated;
			basis = "rate card × tokens";
		} else {
			const siblings = group.filter((s) => s.exact && s.calls > 0 && s.providerCost > 0);
			const avg = siblings.length ? siblings.reduce((a, s) => a + s.providerCost / s.calls, 0) / siblings.length : 0;
			cost = c.calls * avg;
			basis = `est: ${c.calls} calls (status lines) × sibling per-call ${fmt(avg)}`;
		}
		modelTotal += cost;
		grand += cost;
		const cacheCell = c.hasCacheInfo ? `${c.cached.toLocaleString()} (${c.prompt > 0 ? Math.round((c.cached / c.prompt) * 100) : 0}%)` : "n/a";
		lines.push(`| ${c.task} | ${c.arm} | ${c.wallMin}m | ${c.calls} | ${c.prompt.toLocaleString()} | ${cacheCell} | ${c.completion.toLocaleString()} | ${fmt(cost)} | ${basis} |`);
	}
	lines.push(`| **total** | | | | | | | **${fmt(modelTotal)}** | |\n`);
	totals.set(model, modelTotal);
}
lines.push("## Judges and comparisons\n");
{
	let judgeCalls = 0, judgePrompt = 0, judgeCompletion = 0;
	for (const r of Object.values<any>(state.runs)) if (r.status === "done" && r.score) judgeCalls += 1;
	const compFiles = (await readdir(new URL("./", import.meta.url))).filter((f) => f.startsWith("comparisons-") && f.endsWith(".md"));
	for (const f of compFiles) {
		const text = await readFile(new URL("./" + f, import.meta.url), "utf8");
		for (const m of text.matchAll(/remote call: (\d+) prompt(?: \(\d+ cached\))? \+ (\d+) completion/g)) {
			judgePrompt += Number(m[1]);
			judgeCompletion += Number(m[2]);
		}
	}
	const est = judgePrompt * PIN_OFFPEAK + judgeCompletion * POUT_OFFPEAK;
	lines.push(`${judgeCalls} judge calls + ${compFiles.length} head-to-head comparisons: ${judgePrompt.toLocaleString()} prompt + ${judgeCompletion.toLocaleString()} completion tokens.`);
	lines.push(`The deepseek-judged share prices at ~${fmt(est)}; the kimi-k3 comparisons are token-reported only (Moonshot native billing).\n`);
}
lines.push("## Grand total\n");
for (const [m, t] of totals) lines.push(`- ${m}: ${fmt(t)}`);
lines.push(`- **all models: ${fmt(grand)}**`);

const out = lines.join("\n") + "\n";
await writeFile(new URL("./cost-report.md", import.meta.url), out);
console.log(out);
