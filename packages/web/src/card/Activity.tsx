import type { Card, StageRun } from "@tower/core";
import { useMemo } from "react";
import type { Gate } from "../api/client.ts";
import { STAGE_LABEL } from "../board/status.ts";

interface Entry {
	ts: number;
	text: string;
	/** Small verdict chip on the right: pass, fail, waiting, sent back… */
	verdict?: { tone: "ok" | "danger" | "caution" | "rest"; label: string };
	/** The stage move a decision or start caused, as from → to chips. */
	move?: { from: string; to: string };
	/** A one-line quote under the row: a gate's feedback. */
	note?: string | null;
}

/**
 * The card's story, told from what already happened to it: stages entered (as from → to), gates asked
 * and decided, every run with its verdict — day-grouped, newest first. Derived, not recorded: the
 * runs and gates are the log, so there is nothing to keep in sync.
 */
export function Activity({ card, runs, gates }: { card: Card; runs: StageRun[]; gates: Gate[] }) {
	const days = useMemo(() => buildDays(card, runs, gates), [card, runs, gates]);
	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
			{days.map(([label, entries]) => (
				<section key={label} aria-label={label}>
					<h3 className="sticky top-0 bg-sheet py-1.5 text-[12px] font-semibold uppercase tracking-wide text-slate">{label}</h3>
					<ol className="mb-3 flex flex-col gap-1.5">
						{entries.map((entry, index) => (
							<li key={index} className="flex items-start gap-3 rounded-md border border-rule bg-wash/40 px-3 py-2">
								<time dateTime={new Date(entry.ts).toISOString()} className="w-[4.5rem] shrink-0 pt-px text-[12.5px] tabular-nums text-slate">
									{new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
								</time>
								<div className="min-w-0 flex-1">
									<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px]">
										<span>{entry.text}</span>
										{entry.move && (
											<span className="flex items-center gap-1 text-[12.5px] text-slate">
												<span className="rounded bg-wash px-1.5 py-px">{entry.move.from}</span>
												<span aria-hidden>→</span>
												<span className="rounded bg-wash px-1.5 py-px">{entry.move.to}</span>
											</span>
										)}
										{entry.verdict && <span className={`rounded px-1.5 py-px text-[12px] font-semibold ${VERDICT[entry.verdict.tone]}`}>{entry.verdict.label}</span>}
									</p>
									{entry.note && <p className="mt-0.5 truncate text-[13px] text-slate" title={entry.note}>{entry.note}</p>}
								</div>
							</li>
						))}
					</ol>
				</section>
			))}
		</div>
	);
}

const VERDICT: Record<"ok" | "danger" | "caution" | "rest", string> = {
	ok: "bg-ok-soft text-ok",
	danger: "bg-danger-soft text-danger",
	caution: "bg-caution-soft text-caution",
	rest: "bg-wash text-slate",
};

const GATE_ASKED: Record<Gate["kind"], string> = { plan_approval: "Plan approval asked", feedback: "Review asked", budget: "Budget gate asked" };
const GATE_KIND: Record<Gate["kind"], string> = { plan_approval: "Plan approval", feedback: "Review", budget: "Budget gate" };

/** The whole history, grouped into days, newest day first. */
function buildDays(card: Card, runs: StageRun[], gates: Gate[]): Array<[string, Entry[]]> {
	const entries: Entry[] = [{ ts: card.createdAt, text: "Card filed", verdict: { tone: "rest", label: STAGE_LABEL[card.stage === "done" ? "done" : "backlog"] } }];
	const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt);

	// A stage begins when its first run starts — that pair of firsts is the from → to story.
	const stages = [...new Set(sorted.map((run) => run.stage))];
	const stageStarts = new Set(stages.map((stage) => sorted.find((run) => run.stage === stage)?.id));
	stages.forEach((stage, index) => {
		const first = sorted.find((run) => run.stage === stage);
		if (!first) return;
		entries.push({
			ts: first.startedAt,
			text: `${STAGE_LABEL[stage]} started`,
			...(index > 0 && stages[index - 1] !== stage ? { move: { from: STAGE_LABEL[stages[index - 1] as Card["stage"]] ?? stages[index - 1], to: STAGE_LABEL[stage] } } : {}),
		});
	});

	for (const gate of gates) {
		entries.push({ ts: gate.createdAt, text: GATE_ASKED[gate.kind], verdict: { tone: "caution", label: "waiting" } });
		if (gate.decidedAt !== null) {
			const rejected = gate.status === "rejected";
			entries.push({
				ts: gate.decidedAt,
				text: rejected ? `${GATE_KIND[gate.kind]} sent back` : `${GATE_KIND[gate.kind]} approved`,
				verdict: rejected ? { tone: "caution", label: "sent back" } : { tone: "ok", label: "approved" },
				note: gate.feedback,
			});
		}
	}

	for (const run of sorted) {
		// The first run of a stage is that stage's "started" row; later ones are the retries worth showing.
		if (stageStarts.has(run.id)) continue;
		const name = run.kind === "flow_step" ? prettyFlow(run.id) : run.kind === "verify" ? "Verify command" : run.kind === "adhoc" ? "Ad hoc run" : run.kind === "subagent" ? "Crew session" : run.kind === "test" ? "Test run" : `${STAGE_LABEL[run.stage]} attempt`;
		entries.push({
			ts: run.startedAt,
			text: name,
			...(run.attempt > 1 ? { verdict: { tone: "rest" as const, label: `attempt ${run.attempt}` } } : {}),
			...verdictOf(run),
		});
	}

	entries.sort((a, b) => b.ts - a.ts);
	const days = new Map<string, Entry[]>();
	for (const entry of entries) {
		const key = dayLabel(entry.ts);
		const bucket = days.get(key);
		if (bucket) bucket.push(entry);
		else days.set(key, [entry]);
	}
	return [...days];
}

function verdictOf(run: StageRun): { verdict: Entry["verdict"] } | undefined {
	if (run.status === "running" || run.status === "starting") return { verdict: { tone: "caution", label: "running" } };
	if (run.status === "aborted") return { verdict: { tone: "danger", label: "aborted" } };
	if (run.resultStatus === "pass") return { verdict: { tone: "ok", label: "pass" } };
	if (run.resultStatus === "fail") return { verdict: { tone: "danger", label: "fail" } };
	if (run.resultStatus === "blocked") return { verdict: { tone: "caution", label: "asked" } };
	return undefined;
}

/** `c<card>-acceptance-red-write-specs-1` → “acceptance red write specs”. */
function prettyFlow(id: string): string {
	return id.replace(/^c[^-]+-/, "").replace(/-\d+$/, "").replaceAll("-", " ");
}

function dayLabel(ts: number): string {
	const day = new Date(ts);
	const today = new Date();
	const yesterday = new Date(today.getTime() - 86_400_000);
	const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
	if (same(day, today)) return "Today";
	if (same(day, yesterday)) return "Yesterday";
	return day.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
