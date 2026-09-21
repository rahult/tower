import { useQuery } from "@tanstack/react-query";
import type { UsageRow } from "../api/client.ts";
import { api } from "../api/client.ts";
import { formatTokens } from "../projects/Projects.tsx";

const LOCALE_DATE = () => new Date().toLocaleDateString("en-CA");

/** Where the tokens go. Sessions that ran the verify command cost nothing, so they are not counted. */
export function Usage({ onOpenCard, cardTitles, projectNames }: { onOpenCard: (id: string) => void; cardTitles: Map<string, string>; projectNames: Map<string, string> }) {
	const usage = useQuery({ queryKey: ["board", "usage"], queryFn: api.usage });
	if (usage.isPending) return <p className="pt-6 text-center text-[14px] text-slate">Adding it up…</p>;
	if (usage.error) return <p className="pt-6 text-center text-[14px] text-danger">{usage.error.message}</p>;
	const data = usage.data;
	const today = data.byDay.find((row) => row.key === LOCALE_DATE());
	const totals = data.byDay.reduce((sum, row) => ({ tokens: sum.tokens + row.tokens, costUsd: sum.costUsd + row.costUsd, runs: sum.runs + row.runs }), { tokens: 0, costUsd: 0, runs: 0 });
	const maxDay = Math.max(1, ...data.byDay.map((row) => row.tokens));
	const days = [...data.byDay].sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 21);
	const models = [...data.byModel].sort((a, b) => b.tokens - a.tokens);
	const projects = [...data.byProject].sort((a, b) => b.tokens - a.tokens);
	const top = [...data.byCard].sort((a, b) => b.tokens - a.tokens).slice(0, 10);

	return (
		<div className="mx-auto flex w-full max-w-[70rem] flex-col gap-6">
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat label="Today" tokens={today?.tokens ?? 0} cost={today?.costUsd ?? 0} runs={today?.runs ?? 0} strong />
				<Stat label="All time" tokens={totals.tokens} cost={totals.costUsd} runs={totals.runs} />
				<Stat label="Today's sessions" count={today?.runs ?? 0} />
				<Stat label="Models in use" count={models.length} />
			</div>

			<Panel title="By day">
				{days.length === 0 ? (
					<Empty />
				) : (
					<ul className="flex flex-col gap-1.5">
						{days.map((row) => (
							<li key={row.key} className="flex items-center gap-3 text-[13.5px]">
								<span className="w-24 shrink-0 font-mono text-[12.5px] text-slate">{row.key}</span>
								<span className="h-3 min-w-px rounded-sm bg-primary-soft" style={{ width: `${Math.max(1, (row.tokens / maxDay) * 60)}%` }} aria-hidden />
								<span className="ml-auto flex shrink-0 gap-3 tnum">
									<span>{formatTokens(row.tokens)}</span>
									<span className="w-14 text-right text-slate">{row.costUsd > 0 ? `$${row.costUsd.toFixed(2)}` : ""}</span>
									<span className="w-16 text-right text-slate">{row.runs} runs</span>
								</span>
							</li>
						))}
					</ul>
				)}
			</Panel>

			<div className="grid gap-4 lg:grid-cols-2">
				<Panel title="By model">
					<Rows rows={models} empty={models.length === 0} />
				</Panel>
				<Panel title="By project">
					<Rows rows={projects} empty={projects.length === 0} nameFor={(key) => projectNames.get(key) ?? key} />
				</Panel>
			</div>

			<Panel title="Costliest cards">
				{top.length === 0 ? (
					<Empty />
				) : (
					<ul className="flex flex-col gap-1">
						{top.map((row) => (
							<li key={row.key} className="flex items-baseline gap-3 text-[13.5px]">
								<button type="button" onClick={() => onOpenCard(row.key)} className="min-w-0 flex-1 cursor-pointer truncate text-left font-medium hover:underline">
									{cardTitles.get(row.key) ?? row.key}
								</button>
								<span className="shrink-0 text-slate tnum">{row.runs} {row.runs === 1 ? "session" : "sessions"}</span>
								<span className="w-20 shrink-0 text-right tnum">{formatTokens(row.tokens)}</span>
								<span className="w-14 shrink-0 text-right text-slate tnum">{row.costUsd > 0 ? `$${row.costUsd.toFixed(2)}` : ""}</span>
							</li>
						))}
					</ul>
				)}
			</Panel>
		</div>
	);
}

function Stat({ label, tokens, cost, runs, count, strong }: { label: string; tokens?: number; cost?: number; runs?: number; count?: number; strong?: boolean }) {
	return (
		<div className={`rounded-lg border border-rule bg-sheet px-4 py-3 ${strong && (tokens ?? 0) > 0 ? "border-primary/40" : ""}`}>
			<p className="text-[12.5px] font-semibold tracking-wide text-slate uppercase">{label}</p>
			<p className="display mt-0.5 text-[24px] leading-tight font-extrabold tnum">{count !== undefined ? count : formatTokens(tokens ?? 0)}</p>
			{count === undefined && (
				<p className="text-[13px] text-slate tnum">
					{cost !== undefined && cost > 0 && <>${cost.toFixed(2)} · </>}
					{runs !== undefined && `${runs} sessions`}
				</p>
			)}
		</div>
	);
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="rounded-lg border border-rule bg-sheet px-4 py-3">
			<h2 className="display mb-2 text-[15px] font-extrabold">{title}</h2>
			{children}
		</section>
	);
}

function Rows({ rows, empty, nameFor }: { rows: UsageRow[]; empty: boolean; nameFor?: (key: string) => string }) {
	if (empty) return <Empty />;
	return (
		<ul className="flex flex-col gap-1">
			{rows.map((row) => (
				<li key={row.key} className="flex items-baseline gap-3 text-[13.5px]">
					<span className={`min-w-0 flex-1 truncate ${nameFor ? "font-semibold" : "font-mono text-[12.5px]"}`}>{nameFor ? nameFor(row.key) : row.key}</span>
					<span className="shrink-0 text-slate tnum">{row.runs} {row.runs === 1 ? "run" : "runs"}</span>
					<span className="w-20 shrink-0 text-right tnum">{formatTokens(row.tokens)}</span>
					<span className="w-14 shrink-0 text-right text-slate tnum">{row.costUsd > 0 ? `$${row.costUsd.toFixed(2)}` : ""}</span>
				</li>
			))}
		</ul>
	);
}

const Empty = () => <p className="py-3 text-[13.5px] text-slate">No sessions have run yet.</p>;
