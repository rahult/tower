import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { formatMoney, formatTokens } from "../app/bits.tsx";

const LOCALE_DATE = () => new Date().toLocaleDateString("en-CA");

/** Where the tokens go. Sessions that ran the verify command cost nothing, so they are not counted. */
export function Usage({ onOpenCard, cardTitles, projectNames }: { onOpenCard: (id: string) => void; cardTitles: Map<string, string>; projectNames: Map<string, string> }) {
	const usage = useQuery({ queryKey: ["board", "usage"], queryFn: api.usage });
	if (usage.isPending)
		return (
			<section className="view active" aria-label="Usage">
				<div className="page">
					<p className="meta">Adding it up…</p>
				</div>
			</section>
		);
	if (usage.error)
		return (
			<section className="view active" aria-label="Usage">
				<div className="page">
					<p className="text-[14px] text-danger">{usage.error.message}</p>
				</div>
			</section>
		);
	const data = usage.data;
	const today = data.byDay.find((row) => row.key === LOCALE_DATE());
	const totals = data.byDay.reduce((sum, row) => ({ tokens: sum.tokens + row.tokens, costUsd: sum.costUsd + row.costUsd, runs: sum.runs + row.runs }), { tokens: 0, costUsd: 0, runs: 0 });
	const maxDay = Math.max(1, ...data.byDay.map((row) => row.tokens));
	const days = [...data.byDay].sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 21);
	const models = [...data.byModel].sort((a, b) => b.tokens - a.tokens);
	const projects = [...data.byProject].sort((a, b) => b.tokens - a.tokens);
	const top = [...data.byCard].sort((a, b) => b.tokens - a.tokens).slice(0, 10);

	return (
		<section className="view active" aria-label="Usage">
			<div className="page">
				<div className="page-in">
					<div>
						<h1>Usage</h1>
						<p className="lead">
							Every session Tower starts, counted. Planning runs on the expensive model; building and testing on the cheap one — that is where the money goes, and where it does not.
						</p>
					</div>

					<div className="stats">
						<div className="stat">
							<span className="v tnum">{formatTokens(today?.tokens ?? 0)}</span>
							<span className="k">tokens today{today && today.costUsd > 0 ? ` · ${formatMoney(today.costUsd)}` : ""}</span>
						</div>
						<div className="stat">
							<span className="v tnum">{today?.runs ?? 0}</span>
							<span className="k">sessions today</span>
						</div>
						<div className="stat">
							<span className="v tnum">{formatTokens(totals.tokens)}</span>
							<span className="k">tokens all time{totals.costUsd > 0 ? ` · ${formatMoney(totals.costUsd)}` : ""}</span>
						</div>
						<div className="stat">
							<span className="v tnum">{totals.runs}</span>
							<span className="k">sessions all time</span>
						</div>
					</div>

					<section className="sheet">
						<div className="sheet-head">
							<h2>By day</h2>
							<span className="meta">
								Tokens, last {days.length || 0} {days.length === 1 ? "day" : "days"}
							</span>
						</div>
						{days.length === 0 ? (
							<Empty />
						) : (
							<div className="bars px-4 py-3">
								{days.map((row) => (
									<div key={row.key} className="barrow">
										<span className="font-mono text-[12.5px] text-slate">{row.key}</span>
										<div className="track">
											<div className="fill" style={{ width: `${Math.max(1, (row.tokens / maxDay) * 100)}%` }} />
										</div>
										<span className="n tnum">
											{formatTokens(row.tokens)}
											{row.costUsd > 0 ? ` · ${formatMoney(row.costUsd)}` : ""}
										</span>
									</div>
								))}
							</div>
						)}
					</section>

					<section className="sheet">
						<div className="sheet-head">
							<h2>By project</h2>
						</div>
						{projects.length === 0 ? (
							<Empty />
						) : (
							<table className="table">
								<thead>
									<tr>
										<th>Project</th>
										<th className="num hide-sm">Sessions</th>
										<th className="num">Tokens</th>
										<th className="num">Cost</th>
									</tr>
								</thead>
								<tbody>
									{projects.map((row) => (
										<tr key={row.key}>
											<td>
												<strong>{projectNames.get(row.key) ?? row.key}</strong>
											</td>
											<td className="num hide-sm">{row.runs}</td>
											<td className="num tnum">{formatTokens(row.tokens)}</td>
											<td className="num tnum">{row.costUsd > 0 ? formatMoney(row.costUsd) : "—"}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</section>

					<section className="sheet">
						<div className="sheet-head">
							<h2>By model</h2>
						</div>
						{models.length === 0 ? (
							<Empty />
						) : (
							<table className="table">
								<thead>
									<tr>
										<th>Model</th>
										<th className="num hide-sm">Sessions</th>
										<th className="num">Tokens</th>
										<th className="num">Cost</th>
									</tr>
								</thead>
								<tbody>
									{models.map((row) => (
										<tr key={row.key}>
											<td className="font-mono text-[13px]">{row.key}</td>
											<td className="num hide-sm">{row.runs}</td>
											<td className="num tnum">{formatTokens(row.tokens)}</td>
											<td className="num tnum">{row.costUsd > 0 ? formatMoney(row.costUsd) : "—"}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</section>

					<section className="sheet">
						<div className="sheet-head">
							<h2>Costliest cards</h2>
						</div>
						{top.length === 0 ? (
							<Empty />
						) : (
							<table className="table">
								<thead>
									<tr>
										<th>Card</th>
										<th className="num hide-sm">Sessions</th>
										<th className="num">Tokens</th>
										<th className="num">Cost</th>
									</tr>
								</thead>
								<tbody>
									{top.map((row) => (
										<tr key={row.key}>
											<td>
												<button type="button" onClick={() => onOpenCard(row.key)} className="cursor-pointer text-left font-medium hover:underline">
													{cardTitles.get(row.key) ?? row.key}
												</button>
											</td>
											<td className="num hide-sm">{row.runs}</td>
											<td className="num tnum">{formatTokens(row.tokens)}</td>
											<td className="num tnum">{row.costUsd > 0 ? formatMoney(row.costUsd) : "—"}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</section>
				</div>
			</div>
		</section>
	);
}

const Empty = () => <p className="px-4 py-3 text-[13.5px] text-slate">No sessions have run yet.</p>;
