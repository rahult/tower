import type { Card, Project, StageRun } from "@tower/core";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { type Artifact, api, type CardDetail, type Gate } from "../api/client.ts";
import { describeCard, isLive, needsYou, STAGE_LABEL } from "../board/status.ts";
import { ConfirmButton, ErrorNote, TrayHeading, useElapsed, usePastDelay } from "../app/bits.tsx";
import { NewProjectForm } from "../app/quickadd.tsx";
import { button, field } from "../ui.ts";
import { QuestionsPanel } from "../card/QuestionsPanel.tsx";

interface FocusProps {
	projects: Project[];
	cards: Card[];
	activeRuns: StageRun[];
	onOpen: (cardId: string) => void;
	onAddWork: (projectId?: string) => void;
}

const FILTER_KEY = "tower-filter";

/**
 * The default view, ordered by how much the reader is needed: the decisions that block an agent first,
 * then work in flight, then everything waiting, then what finished. A tray that is empty does not render.
 * Many projects can be narrowed to one with the filter chips without losing the global counts.
 */
export function Focus({ projects, cards, activeRuns, onOpen, onAddWork }: FocusProps) {
	const [filter, setFilter] = useState(() => {
		try {
			return localStorage.getItem(FILTER_KEY) ?? "all";
		} catch {
			return "all";
		}
	});
	const pickFilter = (id: string) => {
		setFilter(id);
		try {
			localStorage.setItem(FILTER_KEY, id);
		} catch {
			// Storage refused; the choice lasts for this visit.
		}
	};
	const scope = (list: Card[]) => (filter === "all" ? list : list.filter((card) => card.projectId === filter));

	// Attention is ordered by the card's own priority first, then by age — not by board order.
	const byImportance = (a: Card, b: Card) => b.priority - a.priority || a.createdAt - b.createdAt;
	const attention = scope(cards.filter((card) => needsYou(card) || card.status === "abandoned")).sort(byImportance);
	const queued = scope(cards.filter((card) => card.status === "queued"));
	const backlog = scope(cards.filter((card) => card.stage === "backlog" && card.status === "idle"));
	const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
	const finished = scope(cards.filter((card) => card.stage === "done" && card.updatedAt > dayAgo)).sort((a, b) => b.updatedAt - a.updatedAt);
	const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

	const inFlight = useMemo(() => {
		const ids = new Set(scope(cards).map((card) => card.id));
		const byCard = new Map<string, StageRun[]>();
		for (const run of activeRuns) if (ids.has(run.cardId)) byCard.set(run.cardId, [...(byCard.get(run.cardId) ?? []), run]);
		return [...byCard.entries()].sort((a, b) => (a[1][0]?.startedAt ?? 0) - (b[1][0]?.startedAt ?? 0));
	}, [activeRuns, cards, filter]);

	if (projects.length === 0) return <EmptyBoard />;

	const waitingTotal = cards.filter(needsYou).length;
	const quiet = attention.length === 0 && inFlight.length === 0 && queued.length === 0;
	return (
		<div className="mx-auto flex w-full max-w-[64rem] flex-col gap-8">
			{projects.length > 1 && (
				<div role="group" aria-label="Filter by project" className="flex flex-wrap items-center gap-1.5">
					<FilterChip active={filter === "all"} onClick={() => pickFilter("all")} waiting={waitingTotal}>
						All projects
					</FilterChip>
					{projects.map((project) => {
						const waiting = cards.filter((card) => card.projectId === project.id && (needsYou(card) || card.status === "abandoned")).length;
						return (
							<FilterChip key={project.id} active={filter === project.id} onClick={() => pickFilter(project.id)} waiting={waiting}>
								{project.name}
							</FilterChip>
						);
					})}
				</div>
			)}

			{quiet && cards.length > 0 && (
				<section className="rounded-lg border border-rule bg-sheet px-5 py-6 text-center">
					<p className="display text-[22px] font-extrabold">All clear.</p>
					<p className="mt-1 text-[14px] text-slate">
						Nothing is running and nothing needs you.
						{backlog.length > 0 && ` ${backlog.length} ${backlog.length === 1 ? "card sits" : "cards sit"} in the backlog below.`}{" "}
						<button type="button" onClick={() => onAddWork()} className={`${button.link} !text-[14px]`}>
							Add work
						</button>{" "}
						whenever you like.
					</p>
				</section>
			)}

			{attention.length > 0 && (
				<section aria-label="Needs you">
					<TrayHeading label="Needs you" count={attention.length} tone="caution" hint="These decisions block an agent" />
					<ul className="mt-3 flex flex-col gap-2">
						{attention.map((card) => (
							<AttentionRow key={card.id} card={card} projectName={names.get(card.projectId)} onOpen={onOpen} />
						))}
					</ul>
				</section>
			)}

			{inFlight.length > 0 && (
				<section aria-label="In flight">
					<TrayHeading label="In flight" count={inFlight.length} tone="work" hint="Agents at work; step in only if you must" />
					<ul className="mt-3 flex flex-col gap-2">
						{inFlight.map(([cardId, runs]) => (
							<FlightRow key={cardId} card={cards.find((card) => card.id === cardId)} runs={runs} onOpen={onOpen} />
						))}
					</ul>
				</section>
			)}

			{queued.length > 0 && (
				<section aria-label="Waiting for a slot">
					<TrayHeading label="Waiting for a slot" count={queued.length} tone="work" />
					<ul className="mt-3 flex flex-col gap-2">
						{queued.map((card) => (
							<QueueRow key={card.id} card={card} projectName={names.get(card.projectId)} onOpen={onOpen} />
						))}
					</ul>
				</section>
			)}

			{backlog.length > 0 && (
				<section aria-label="Backlog">
					<TrayHeading label="Backlog" count={backlog.length} tone="rest" hint="Told to wait for your go" />
					<Backlog cards={backlog} names={names} onOpen={onOpen} />
				</section>
			)}

			{finished.length > 0 && (
				<section aria-label="Finished today">
					<TrayHeading label="Finished today" count={finished.length} tone="ok" />
					<ul className="mt-3 flex flex-col gap-1.5">
						{finished.slice(0, 6).map((card) => (
							<DoneRow key={card.id} card={card} onOpen={onOpen} />
						))}
					</ul>
					{finished.length > 6 && (
						<p className="mt-2 text-[13px] text-slate">
							And {finished.length - 6} more — the <button type="button" onClick={() => (window.location.hash = "#board")} className={button.link}>board</button> keeps the rest (unfold Done there).
						</p>
					)}
				</section>
			)}
		</div>
	);
}

function EmptyBoard() {
	return (
		<div className="mx-auto flex w-full max-w-[44rem] flex-col items-start gap-5 pt-8">
			<div>
				<h2 className="display text-[26px] font-extrabold">Your control tower is empty.</h2>
				<p className="mt-2 max-w-[52ch] text-[15px] text-slate">
					Add a git repository from this machine, then hand Tower a piece of work. It plans with a strong model, builds with a cheap one, lets your tests judge the result, and asks
					you only when a decision is yours.
				</p>
			</div>
			<NewProjectForm first />
		</div>
	);
}

/** The amber rows: one decision each, with the action in place so the drawer is optional. */
function AttentionRow({ card, projectName, onOpen }: { card: Card; projectName: string | undefined; onOpen: (id: string) => void }) {
	const detail = useQueryCard(card.id);
	const queryClient = useQueryClient();
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ["board"] });
		void queryClient.invalidateQueries({ queryKey: ["card", card.id] });
	};
	const decide = useMutation({ mutationFn: (input: { gateId: string; decision: "approve" | "reject"; feedback?: string }) => api.decideGate(card.id, input.gateId, input.decision, input.feedback), onSuccess: refresh });
	const resume = useMutation({ mutationFn: () => api.resume(card.id), onSuccess: refresh });
	const retry = useMutation({ mutationFn: (feedback?: string) => api.retry(card.id, feedback), onSuccess: refresh });
	const [sendingBack, setSendingBack] = useState(false);
	const [note, setNote] = useState("");
	const openRow = () => onOpen(card.id);

	const { status } = describeCard(card);
	const gate = detail.data?.gates.find((g) => g.status === "pending") ?? null;
	const asked = card.status === "awaiting_input" ? (detail.data?.runs.at(-1)?.questions ?? null) : null;
	const pending = detail.isPending;

	let context = "";
	let actions: ReactNode = null;
	let expand: ReactNode = null;

	if (gate?.kind === "plan_approval") {
		context = "The plan is ready. A cheap model will build from it alone, so it has to stand on its own.";
		actions = (
			<>
				<RowButton kind="primary" busy={decide.isPending} onClick={() => decide.mutate({ gateId: gate.id, decision: "approve" })}>
					Approve & build
				</RowButton>
				<RowButton onClick={openRow}>Read plan</RowButton>
				<RowButton onClick={() => setSendingBack((on) => !on)}>Send back…</RowButton>
			</>
		);
		expand =
			sendingBack && gate ? (
				<SendBack note={note} setNote={setNote} busy={decide.isPending} onSend={() => decide.mutate({ gateId: gate.id, decision: "reject", feedback: note.trim() })} onCancel={() => setSendingBack(false)} />
			) : null;
	} else if (gate?.kind === "feedback") {
		const runs = detail.data?.runs ?? [];
		const verdicts = new Map<string, StageRun>();
		for (const run of runs) if (run.kind === "flow_step") verdicts.set(flowName(run), run);
		const blocking = [...verdicts.values()].filter((run) => run.resultStatus === "fail").length;
		const checks = runs.findLast((run) => run.kind === "verify" || (run.kind === "stage" && run.stage === "testing"));
		const reports = (detail.data?.artifacts ?? []).filter((artifact) => artifact.name.startsWith("reviews/"));
		context =
			blocking > 0
				? `${blocking} review${blocking === 1 ? "" : "s"} found something blocking${checks?.resultSummary ? `. ${checks.resultSummary}` : "."}`
				: checks
					? `${checks.resultSummary ?? "Checks are in."} Reviews are in. Approving opens the pull request.`
					: "The work is done and reviewed. Approving opens the pull request.";
		if (reports.length === 0) context = "The work is done. Approving opens the pull request.";
		actions = (
			<>
				<RowButton kind="primary" busy={decide.isPending} onClick={() => decide.mutate({ gateId: gate.id, decision: "approve" })}>
					Approve & open PR
				</RowButton>
				<RowButton onClick={openRow}>Read findings</RowButton>
				<RowButton onClick={() => setSendingBack((on) => !on)}>Send back…</RowButton>
			</>
		);
		expand =
			sendingBack && gate ? (
				<SendBack
					note={note}
					setNote={setNote}
					busy={decide.isPending}
					placeholder={reports.length > 0 ? `Address the blocking findings in ${reports.map((report) => report.name).join(" and ")}.` : "What should change?"}
					onSend={() => decide.mutate({ gateId: gate.id, decision: "reject", feedback: note.trim() })}
					onCancel={() => setSendingBack(false)}
				/>
			) : null;
	} else if (asked) {
		// The questions render right here, so the only button needed is a quiet way into the full card.
		context = card.needsAttentionReason ?? `The agent stopped to ask ${asked.length === 1 ? "a question" : `${asked.length} questions`}.`;
		actions = <RowButton onClick={openRow}>Open</RowButton>;
		expand = <QuestionsPanel cardId={card.id} summary={null} questions={asked} className="mt-2 max-h-[26rem] overflow-y-auto rounded-md border border-caution/50 bg-sheet" />;
	} else if (card.status === "abandoned") {
		context = card.needsAttentionReason ?? "This card was abandoned and went no further. Running it again starts a fresh session on the same branch.";
		actions = (
			<>
				<RowButton kind="primary" busy={retry.isPending} onClick={() => retry.mutate()}>
					Run again
				</RowButton>
				<RowButton onClick={openRow}>Open</RowButton>
			</>
		);
	} else if (card.status === "interrupted") {
		context = "A restart cut this session off. Resume continues the same pi session where it stopped.";
		actions = (
			<>
				<RowButton kind="primary" busy={resume.isPending} onClick={() => resume.mutate()}>
					Resume
				</RowButton>
				<RowButton onClick={openRow}>Open</RowButton>
			</>
		);
	} else {
		context = card.needsAttentionReason ?? "The loop stopped and wants a decision.";
		if (card.stage === "testing" && card.status === "idle") {
			context = card.needsAttentionReason ?? "The build passed but the stage did not finish. Continue to the reviews.";
			actions = (
				<>
					<RowButton kind="primary" busy={retry.isPending} onClick={() => retry.mutate()}>
						Continue
					</RowButton>
					<RowButton onClick={openRow}>Open</RowButton>
				</>
			);
		} else {
			actions = (
				<>
					<RowButton kind="primary" busy={retry.isPending} onClick={() => retry.mutate()}>
						Run again
					</RowButton>
					<RowButton onClick={openRow}>Open</RowButton>
				</>
			);
		}
	}

	const abandoned = card.status === "abandoned";
	return (
		<li className={`flex flex-col rounded-lg border ${abandoned ? "border-danger/40 bg-danger-soft" : status === "Waiting for your answer" || gate ? "border-caution bg-caution-soft" : "border-caution/50 bg-caution-soft/60"}`}>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
				<div className="min-w-0 flex-1 basis-56">
					<p className="flex items-center gap-2 text-[12px] text-slate">
						<span className={`rounded px-1.5 py-px font-semibold ${abandoned ? "bg-danger-soft text-danger" : "bg-caution/15 text-caution-text"}`}>{gate ? (gate.kind === "plan_approval" ? "Plan approval" : "Review work") : status}</span>
						{projectName && <span className="truncate">{projectName}</span>}
					</p>
					<button type="button" onClick={() => onOpen(card.id)} className="mt-0.5 block cursor-pointer text-left leading-snug font-semibold hover:underline">
						{card.title}
					</button>
					{pending ? <p className="mt-0.5 text-[13px] text-slate">Reading the card…</p> : <p className="mt-0.5 text-[13.5px] leading-snug text-ink/80">{context}</p>}
				</div>
				<div className="flex flex-wrap items-center gap-2">{actions}</div>
			</div>
			{expand && <div className="border-t border-caution/25 px-4 py-3">{expand}</div>}
			{(decide.error ?? resume.error ?? retry.error) && (
				<div className="border-t border-caution/25 px-4 py-2">
					<ErrorNote error={(decide.error ?? resume.error ?? retry.error) ?? null} onRetry={refresh} />
				</div>
			)}
		</li>
	);
}

function SendBack({ note, setNote, onSend, onCancel, busy, placeholder }: { note: string; setNote: (v: string) => void; onSend: () => void; onCancel: () => void; busy: boolean; placeholder?: string }) {
	return (
		<div className="flex flex-col gap-2">
			<label htmlFor="send-back-note" className="text-[13px] text-slate">
				Say what should change. The stage starts over with your note.
			</label>
			<textarea id="send-back-note" value={note} onChange={(event) => setNote(event.target.value)} rows={2} autoFocus placeholder={placeholder ?? "Keep the public API unchanged"} className={`${field} resize-y`} />
			<div className="flex items-center gap-2">
				<RowButton kind="primary" disabled={!note.trim() || busy} onClick={onSend}>
					Send back
				</RowButton>
				<RowButton onClick={onCancel}>Cancel</RowButton>
			</div>
		</div>
	);
}

/** A card with a session running. Quiet on purpose: the agent is working, and that is not a question. */
function FlightRow({ card, runs, onOpen }: { card: Card | undefined; runs: StageRun[]; onOpen: (id: string) => void }) {
	const queryClient = useQueryClient();
	const abort = useMutation({ mutationFn: (cardId: string) => api.abort(cardId), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board"] }) });
	const primary = runs.find((run) => run.kind !== "verify") ?? runs[0];
	const elapsed = useElapsed(primary?.startedAt, true);
	const label =
		primary === undefined
			? "Working"
			: primary.kind === "verify"
				? "Running your checks"
				: primary.kind === "flow_step"
					? `Review · ${flowName(primary).replaceAll("-", " ")}`
					: `${STAGE_LABEL[primary.stage]}${primary.attempt > 1 ? ` · attempt ${primary.attempt}` : ""}`;
	if (!card) return null;
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-rule bg-sheet px-4 py-3">
			<span aria-hidden className="sweep h-8 w-1 rounded-full" />
			<div className="min-w-0 flex-1 basis-56">
				<button type="button" onClick={() => onOpen(card.id)} className="block max-w-full cursor-pointer truncate text-left font-semibold hover:underline" title={card.title}>
					{card.title}
				</button>
				<p className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5 text-[13px] text-slate">
					<span className="rounded bg-primary-soft px-1.5 py-px font-semibold text-primary">{label}</span>
					<span className="tnum">{elapsed}</span>
					{primary && primary.kind !== "verify" && <span className="font-mono text-[12px]">{short(primary.model)}</span>}
				</p>
			</div>
			<div className="flex items-center gap-2">
				<RowButton onClick={() => onOpen(card.id)}>Open</RowButton>
				<ConfirmButton small label="Abort" confirmLabel="Confirm abort?" onConfirm={() => abort.mutate(card.id)} busy={abort.isPending} />
			</div>
		</li>
	);
}

function QueueRow({ card, projectName, onOpen }: { card: Card; projectName: string | undefined; onOpen: (id: string) => void }) {
	const queryClient = useQueryClient();
	const remove = useMutation({ mutationFn: () => api.abort(card.id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board"] }) });
	return (
		<li className="flex flex-wrap items-center gap-x-3 rounded-lg border border-rule bg-sheet px-4 py-2.5">
			<div className="min-w-0 flex-1 basis-56">
				<button type="button" onClick={() => onOpen(card.id)} className="block max-w-full cursor-pointer truncate text-left font-semibold hover:underline">
					{card.title}
				</button>
				<p className="text-[13px] text-slate">Queued{projectName ? ` · ${projectName}` : ""} — starts when a slot frees</p>
			</div>
			<div className="flex items-center gap-2">
				<RowButton onClick={() => onOpen(card.id)}>Open</RowButton>
				<ConfirmButton small label="Remove" confirmLabel="Confirm remove?" onConfirm={() => remove.mutate()} busy={remove.isPending} />
			</div>
		</li>
	);
}

function Backlog({ cards, names, onOpen }: { cards: Card[]; names: Map<string, string>; onOpen: (id: string) => void }) {
	const [expanded, setExpanded] = useState(false);
	const shown = expanded ? cards : cards.slice(0, 4);
	return (
		<>
			<ul className="mt-3 flex flex-col gap-1.5">
				{shown.map((card) => (
					<BacklogRow key={card.id} card={card} projectName={names.get(card.projectId)} onOpen={onOpen} />
				))}
			</ul>
			{cards.length > 4 && (
				<button type="button" onClick={() => setExpanded((on) => !on)} className={`${button.link} mt-2`}>
					{expanded ? "Show less" : `Show all ${cards.length}`}
				</button>
			)}
		</>
	);
}

function BacklogRow({ card, projectName, onOpen }: { card: Card; projectName: string | undefined; onOpen: (id: string) => void }) {
	const queryClient = useQueryClient();
	const start = useMutation({ mutationFn: () => api.enqueue(card.id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board"] }) });
	return (
		<li className="flex flex-wrap items-center gap-x-3 rounded-lg border border-rule bg-sheet px-4 py-2.5">
			<div className="min-w-0 flex-1 basis-56">
				<button type="button" onClick={() => onOpen(card.id)} className="block max-w-full cursor-pointer truncate text-left font-semibold hover:underline">
					{card.title}
				</button>
				<p className="text-[13px] text-slate">{projectName}</p>
			</div>
			<div className="flex items-center gap-2">
				<RowButton kind="primary" busy={start.isPending} onClick={() => start.mutate()}>
					Start
				</RowButton>
				<RowButton onClick={() => onOpen(card.id)}>Open</RowButton>
			</div>
		</li>
	);
}

function DoneRow({ card, onOpen }: { card: Card; onOpen: (id: string) => void }) {
	// A slow tick keeps the age honest without re-rendering every second.
	useElapsed(card.updatedAt, true, 30_000);
	return (
		<li className="flex flex-wrap items-center gap-x-3 rounded-lg border border-ok/25 bg-ok-soft/50 px-4 py-2">
			<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-ok" />
			<button type="button" onClick={() => onOpen(card.id)} className="min-w-0 flex-1 basis-56 cursor-pointer truncate text-left text-[14px] hover:underline">
				{card.title}
			</button>
			{card.prUrl && (
				<a href={card.prUrl} target="_blank" rel="noreferrer noopener" className="font-mono text-[12.5px] text-primary underline underline-offset-4">
					{card.prUrl.replace("https://github.com/", "")}
				</a>
			)}
			<span className="text-[12.5px] text-slate">finished {formatAgo(card.updatedAt)}</span>
		</li>
	);
}

// --- shared row plumbing ---------------------------------------------------

function FilterChip({ active, onClick, waiting, children }: { active: boolean; onClick: () => void; waiting: number; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium ${active ? "border-primary bg-primary-soft font-semibold text-primary" : "border-rule bg-sheet text-slate hover:text-ink"}`}
		>
			{children}
			{waiting > 0 && <span className="rounded-full bg-caution px-1.5 font-mono text-[11px] font-bold text-caution-ink">{waiting}</span>}
		</button>
	);
}

function RowButton({ kind = "quiet", busy, disabled, onClick, children }: { kind?: keyof typeof button; busy?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button type="button" onClick={onClick} disabled={disabled || busy} className={`${button[kind]} !px-2.5 !py-1 !text-[13px] whitespace-nowrap`}>
			{busy ? "…" : children}
		</button>
	);
}

function useQueryCard(cardId: string) {
	const queries = useQueries({
		queries: [{ queryKey: ["card", cardId], queryFn: () => api.card(cardId) }],
	});
	const result = queries[0];
	return { data: result?.data as CardDetail | undefined, isPending: usePastDelay(result?.isPending ?? false) };
}

const flowName = (run: StageRun) => run.id.replace(/^c[^-]+-/, "").replace(/-\d+$/, "");
const short = (model: string) => model.split("/").pop()?.split(":")[0] ?? model;

function formatAgo(at: number): string {
	const seconds = Math.max(1, Math.floor((Date.now() - at) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}
