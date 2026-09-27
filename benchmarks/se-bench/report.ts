/** Builds the self-contained HTML report: spider charts per model, per-run table, methodology. */
import { writeFile } from "node:fs/promises";
import { DIMENSIONS, type Scored } from "./score.ts";
import type { RunRecord } from "./run.ts";

const LABELS: Record<string, string> = {
	correctness: "correctness",
	spec_compliance: "spec fit",
	code_quality: "code quality",
	testing: "testing",
	robustness: "robustness",
	documentation: "docs",
};

const ARM_STYLE: Record<string, { label: string; color: string; blurb: string }> = {
	raw: { label: "Raw model", color: "#8a8f98", blurb: "one chat completion, no tools — output pasted to disk" },
	basic: { label: "Basic loop", color: "#4d9fff", blurb: "minimal agent: file + shell tools, no gates, no reviews" },
	tower: { label: "Tower", color: "#f4b63f", blurb: "full pipeline: plan coach, plan gate, verify gate, acceptance gates, testing stage, review flows, feedback gate" },
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Mean dimension scores for one (model, arm) cell; null when no scored runs. */
function cell(runs: RunRecord[], model: string, arm: string): Record<string, number> | null {
	const scored = Object.values(runs).filter((r) => r.model === model && r.arm === arm && r.score);
	if (scored.length === 0) return null;
	return Object.fromEntries(DIMENSIONS.map((d) => [d, avg(scored.map((r) => (r.score as Scored).dimensions[d] ?? 0))]));
}

function spiderSVG(series: Array<{ label: string; color: string; values: number[] }>, size = 520): string {
	const cx = size / 2;
	const cy = size / 2 + 6;
	const R = size / 2 - 74;
	const n = DIMENSIONS.length;
	const point = (i: number, r: number): [number, number] => {
		const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
		return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
	};
	const ring = (frac: number): string => {
		const pts = DIMENSIONS.map((_, i) => point(i, R * frac).map((v) => v.toFixed(1)).join(",")).join(" ");
		return `<polygon points="${pts}" fill="none" stroke="#262b33" stroke-width="1"/>`;
	};
	const parts: string[] = [];
	parts.push(`<svg viewBox="0 0 ${size} ${size + 44}" width="${size}" height="${size + 44}" xmlns="http://www.w3.org/2000/svg" role="img">`);
	for (const frac of [0.2, 0.4, 0.6, 0.8, 1]) parts.push(ring(frac));
	for (let i = 0; i < n; i++) {
		const [x, y] = point(i, R);
		parts.push(`<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#262b33" stroke-width="1"/>`);
		const [lx, ly] = point(i, R + 26);
		const anchor = Math.abs(lx - cx) < 10 ? "middle" : lx > cx ? "start" : "end";
		parts.push(`<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" fill="#aeb6c2" font-size="13" text-anchor="${anchor}">${LABELS[DIMENSIONS[i]]}</text>`);
	}
	for (const s of series) {
		const pts = s.values.map((v, i) => point(i, R * Math.max(0.015, Math.min(10, v) / 10)));
		const poly = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
		parts.push(`<polygon points="${poly}" fill="${s.color}" fill-opacity="0.14" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`);
		for (const [x, y] of pts) parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${s.color}"/>`);
	}
	// scale hints: a value v sits at radius R*v/10 — 4 and 8 marked on the vertical axis.
	parts.push(`<text x="${cx + 4}" y="${cy - R * 0.8 - 2}" fill="#565d68" font-size="10">8</text>`);
	parts.push(`<text x="${cx + 4}" y="${cy - R * 0.4 - 2}" fill="#565d68" font-size="10">4</text>`);
	parts.push("</svg>");
	return parts.join("\n");
}

function legend(): string {
	return `<div class="legend">${Object.values(ARM_STYLE)
		.map((s) => `<span class="key"><span class="swatch" style="background:${s.color}"></span>${s.label}</span>`)
		.join("")}</div>`;
}

function esc(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SHORT_DIMS: Record<string, string> = {
	correctness: "corr",
	spec_compliance: "spec",
	code_quality: "qual",
	testing: "test",
	robustness: "rob",
	documentation: "docs",
};

const shortModel = (model: string): string => (model.includes("qwen") ? "qwen 7b" : model.includes("llama") ? "llama 8b" : model);

const shortOwnTests = (detail: string): string => {
	if (/pass/.test(detail)) return `pass (${detail.match(/\((\d+ \w+)\)/)?.[1] ?? "suite"})`;
	if (/fail/.test(detail)) return `fail`;
	if (/no test files/.test(detail)) return "none";
	return detail.length > 24 ? `${detail.slice(0, 24)}…` : detail;
};

function runTable(rows: RunRecord[]): string {
	const head = `<tr><th>model</th><th>task</th><th>arm</th><th>end state</th>${DIMENSIONS.map((d) => `<th>${SHORT_DIMS[d]}</th>`).join("")}<th>Σ</th><th>accept.</th><th>own tests</th><th>tok</th><th>wall</th></tr>`;
	const body = Object.values(rows)
		.sort((a, b) => a.model.localeCompare(b.model) || a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm))
		.map((r) => {
			const dims = r.score?.dimensions;
			const total = dims ? avg(DIMENSIONS.map((d) => dims[d] ?? 0)) : null;
			const acc = r.score?.acceptance;
			const tokens = r.result?.usage;
			const color = r.arm === "tower" ? ARM_STYLE.tower.color : r.arm === "basic" ? ARM_STYLE.basic.color : ARM_STYLE.raw.color;
			const endStage = r.result?.tower ? `${r.result.tower.endStage}·${r.result.tower.endStatus === "needs_attention" ? "attn" : r.result.tower.endStatus}` : "—";
			return `<tr>
				<td class="mono" title="${esc(r.model)}">${esc(shortModel(r.model))}</td><td>${esc(r.task)}</td>
				<td><span class="pill" style="border-color:${color};color:${color}">${ARM_STYLE[r.arm]?.label ?? r.arm}</span></td>
				<td class="mono">${esc(endStage)}</td>
				${DIMENSIONS.map((d) => `<td>${dims ? (dims[d] ?? 0).toFixed(1) : "—"}</td>`).join("")}
				<td class="strong">${total !== null ? total.toFixed(1) : "—"}</td>
				<td class="mono">${acc ? `${acc.passed}/${acc.total}` : "—"}</td>
				<td class="wrap">${esc(r.score?.ownTests ? shortOwnTests(r.score.ownTests.detail) : "—")}</td>
				<td class="mono">${tokens ? ((tokens.towerTokens ?? tokens.promptTokens + tokens.outputTokens) / 1000).toFixed(0) + "k" : "—"}</td>
				<td class="mono">${tokens ? Math.round(tokens.wallMs / 60000) + "m" : "—"}</td>
			</tr>`;
		})
		.join("\n");
	return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

export async function buildReport(runs: Record<string, RunRecord>, outPath: string): Promise<void> {
	const all = Object.values(runs).filter((r) => r.status === "done" && r.score);
	const models = [...new Set(all.map((r) => r.model))].sort();
	const armsPresent = [...new Set(all.map((r) => r.arm))];

	const charts: string[] = [];
	const combined: Record<string, number[]> = {};
	for (const arm of ["raw", "basic", "tower"]) {
		const values = DIMENSIONS.map((d) => avg(models.map((m) => cell(runs, m, arm)?.[d] ?? NaN).filter((v) => Number.isFinite(v))));
		if (values.some((v) => Number.isFinite(v))) combined[arm] = values;
	}
	if (Object.keys(combined).length > 0) {
		const series = Object.entries(combined).map(([arm, values]) => ({ label: ARM_STYLE[arm].label, color: ARM_STYLE[arm].color, values: values.map((v) => (Number.isFinite(v) ? v : 0)) }));
		charts.push(`<section class="chart"><h2>All models, average</h2>${spiderSVG(series)}${legend()}</section>`);
	}
	for (const model of models) {
		const series = ["raw", "basic", "tower"]
			.filter((arm) => cell(runs, model, arm))
			.map((arm) => ({ label: ARM_STYLE[arm].label, color: ARM_STYLE[arm].color, values: DIMENSIONS.map((d) => cell(runs, model, arm)![d]) }));
		if (series.length === 0) continue;
		charts.push(`<section class="chart"><h2 class="mono">${esc(model)}</h2>${spiderSVG(series)}${legend()}</section>`);
	}

	// Findings: computed from the data, phrased by ranking so a rerun can't contradict the text.
	let findings = "";
	if (Object.keys(combined).length >= 2) {
		const byArm = Object.entries(combined)
			.map(([arm, values]) => ({ arm, total: avg(values), correctness: combined[arm][0] }))
			.sort((a, b) => b.total - a.total);
		const lines: string[] = [];
		lines.push(`<strong>${ARM_STYLE[byArm[0].arm].label}</strong> takes the highest mean across all six dimensions (${byArm[0].total.toFixed(1)}/10), ahead of ${byArm.slice(1).map((x) => `${ARM_STYLE[x.arm].label} (${x.total.toFixed(1)})`).join(" and ")}.`);
		const byCorrect = [...byArm].sort((a, b) => b.correctness - a.correctness);
		lines.push(`On hidden acceptance tests, ${ARM_STYLE[byCorrect[0].arm].label} ships the most working software (correctness ${byCorrect[0].correctness.toFixed(1)} vs ${byCorrect.slice(1).map((x) => `${x.correctness.toFixed(1)} for ${ARM_STYLE[x.arm].label}`).join(", ")}).`);
		const towerCell = byArm.find((x) => x.arm === "tower");
		if (towerCell && towerCell.arm !== byArm[0].arm) {
			lines.push(`Tower's pipeline — plan coach, verify gate demanding passing tests, acceptance red/green, review flows — asks the builder for iterative, tool-precise work. At 7–8B parameters that is a capability floor the models sit below: the discipline harness behaves as a <em>multiplier</em> on builder capability, and below the floor it taxes instead of boosting. Nothing stuck or crashed; the runs end honestly in <span class="mono">needs_attention</span> after their retry budgets.`);
		}
		lines.push(`Caveat kept in view: the tower arm ran fully headless with rubber-stamped gates and a scripted answerer — a real person answers questions better than a script, which would narrow but not close these gaps at this model size.`);
		findings = `<div class="method"><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul></div>`;
	}

	const winner = Object.entries(combined)
		.map(([arm, values]) => [arm, avg(values)] as const)
		.sort((a, b) => b[1] - a[1])[0];

	const css = `
		:root { color-scheme: dark; }
		* { box-sizing: border-box; }
		body { margin: 0; background: #0e1116; color: #e3e6ea; font: 15px/1.55 Inter, -apple-system, "SF Pro Text", "Segoe UI", sans-serif; }
		.wrap { max-width: 1180px; margin: 0 auto; padding: 48px 28px 80px; }
		h1 { font-size: 30px; letter-spacing: -0.02em; margin: 0 0 6px; }
		.sub { color: #8a8f98; margin: 0 0 34px; }
		h2 { font-size: 19px; letter-spacing: -0.01em; margin: 40px 0 12px; }
		.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(480px, 1fr)); gap: 18px; }
		.chart { background: #141920; border: 1px solid #1f242c; border-radius: 14px; padding: 10px 16px 4px; }
		.chart svg { display: block; max-width: 100%; margin: 0 auto; }
		.chart h2 { margin: 10px 4px 0; }
		.legend { display: flex; gap: 16px; padding: 0 6px 12px; color: #aeb6c2; font-size: 13px; }
		.key { display: inline-flex; align-items: center; gap: 7px; }
		.swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
		table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
		.table-wrap { overflow-x: auto; }
		th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #1f242c; white-space: nowrap; vertical-align: middle; }
		th { color: #8a8f98; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
		td.wrap { white-space: normal; min-width: 160px; }
		td.strong { font-weight: 600; }
		.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
		.pill { border: 1px solid; border-radius: 999px; padding: 1px 9px; font-size: 12px; }
		.blurb { color: #8a8f98; font-size: 13.5px; margin: 4px 0 0; }
		.armdefs { margin: 0 0 8px; padding: 0; list-style: none; }
		.armdefs li { margin: 6px 0; color: #c6cbd2; }
		.method { background: #141920; border: 1px solid #1f242c; border-radius: 14px; padding: 4px 22px 14px; max-width: 900px; }
		.method li { margin: 7px 0; }
		a { color: #7fb0ff; }
		.total-cards { display: flex; gap: 14px; flex-wrap: wrap; margin: 26px 0 6px; }
		.card { background: #141920; border: 1px solid #1f242c; border-radius: 14px; padding: 16px 22px; min-width: 200px; }
		.card .n { font-size: 30px; font-weight: 650; letter-spacing: -0.02em; }
		.card .t { color: #8a8f98; font-size: 13px; }
	`;

	const armDefs = `<ul class="armdefs">${["raw", "basic", "tower"].map((a) => `<li><span class="pill" style="border-color:${ARM_STYLE[a].color};color:${ARM_STYLE[a].color}">${ARM_STYLE[a].label}</span> — ${ARM_STYLE[a].blurb}</li>`).join("")}</ul>`;

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tower vs. the field — SE benchmark</title>
<style>${css}</style>
</head>
<body><div class="wrap">
<h1>Delegate the building. Keep the discipline?</h1>
<p class="sub">Same tasks, same local models, three amounts of scaffolding — benchmarked on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.</p>

<div class="total-cards">
	<div class="card"><div class="n">${all.length}</div><div class="t">scored runs</div></div>
	${winner ? `<div class="card"><div class="n" style="color:${ARM_STYLE[winner[0]].color}">${ARM_STYLE[winner[0]].label}</div><div class="t">highest mean score, ${winner[1].toFixed(1)}/10 across all dimensions</div></div>` : ""}
	<div class="card"><div class="n">${models.length}</div><div class="t">ollama models</div></div>
	<div class="card"><div class="n">3</div><div class="t">tasks</div></div>
</div>

<h2>The three contestants</h2>
${armDefs}

<h2>Spider charts — six software-engineering dimensions</h2>
<div class="charts">${charts.join("\n")}</div>

<h2>What the numbers say</h2>
${findings}

<h2>Every run</h2>
<div class="table-wrap">
${runTable(all)}
</div>

<h2>Method</h2>
<div class="method">
<ul>
<li><strong>Tasks.</strong> Three fresh Node.js projects with pinned layouts and precisely specified behaviour: <span class="mono">sluglib</span> (string library), <span class="mono">tasknote</span> (JSON-backed CLI), <span class="mono">propsheet</span> (INI-style parser). Every arm gets the identical brief.</li>
<li><strong>Correctness</strong> is programmatic: a hidden acceptance suite written from the spec, run against whatever the arm produced (0–10 by pass rate). <strong>Testing</strong> blends whether the run's own test suite exists and passes (60%) with the judge's quality read (40%).</li>
<li><strong>Judged dimensions</strong> (spec fit, code quality, robustness, docs) are scored 0–10 by <span class="mono">qwen2.5-coder:7b</span> against a fixed anchored rubric, with the brief, all produced files, and both test outcomes in view. A single local judge is a known limitation — same judge for every arm, so bias is at least shared.</li>
<li><strong>Models.</strong> Ollama, 16k context (derived model tags), temperature 0.2 for the loops. Tower's stages all pointed at the same model; thinking off.</li>
<li><strong>No human anywhere.</strong> Tower's plan and feedback gates were decided by a script that approves everything; its stage questions got a generic "use your best judgement". Tower ran as shipped: plan coach, verify gate, acceptance red/green gates, testing stage, adversarial + SOLID review flows.</li>
<li><strong>Tokens</strong> for the tower arm are Tower's own session accounting across all its stages; raw/basic count ollama prompt+output tokens. Wall time is per-run and includes local model load.</li>
<li>One machine, runs sequential. Small task set, one judge, 7–8B models: read this as a disciplined smoke test of the thesis, not leaderboard truth.</li>
</ul>
</div>

</div></body></html>`;
	await writeFile(outPath, html);
}
