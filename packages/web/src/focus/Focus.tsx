import type { Card, Project, StageRun } from "@tower/core";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { api, type CardDetail } from "../api/client.ts";
import { describeCard, isLive, needsYou, STAGE_LABEL } from "../board/status.ts";
import { ConfirmButton, ErrorNote, shortModel, useElapsed, usePastDelay } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { toast } from "../app/toasts.tsx";
import { NewProjectForm } from "../app/quickadd.tsx";
import { button, field } from "../ui.ts";

interface FocusProps {
	projects: Project[];
	cards: Card[];
	activeRuns: StageRun[];
	selectedCardId: string | null;
	/** "all", or a project id — owned by the app so the command palette can set it too. */
	filter: string;
	onFilter: (projectId: string | null) => void;
	onOpen: (cardId: string) => void;
	onAddWork: (projectId?: string) => void;
	onOpenModels: () => void;
}

/**
 * The default view. A rail of projects on the left; the stream on the right, ordered by how much the
 * reader is needed: the decisions that block an agent first, then work in flight, then everything
 * waiting, then what finished. A tray that is empty does not render.
 */
export function Focus({ projects, cards, activeRuns, selectedCardId, filter, onFilter, onOpen, onAddWork, onOpenModels }: FocusProps) {
	const pickFilter = (id: string) => onFilter(id === "all" ? null : id);
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeRuns, cards, filter]);

	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });

	if (projects.length === 0) {
		return (
			<section className="view active" id="view-tower" aria-label="Tower">
				<aside className="rail" aria-label="Projects">
					<div className="rail-head flex items-center gap-2">
						<span className="label flex-1">Projects</span>
					</div>
					<div className="rail-list" />
				</aside>
				<div className="stream" id="stream" tabIndex={-1}>
					<EmptyBoard />
				</div>
			</section>
		);
	}

	const openTotal = cards.filter((card) => card.stage !== "done").length;
	const filteredProject = projects.find((project) => project.id === filter);
	const groupsUsed = attention.length + inFlight.length + queued.length + backlog.length + finished.length;

	return (
		<section className="view active" id="view-tower" aria-label="Tower">
			<aside className="rail" aria-label="Projects">
				<div className="rail-head flex items-center gap-2">
					<span className="label flex-1">Projects</span>
					<span className="meta mono text-[12px]">{openTotal} open</span>
				</div>
				<div className="rail-list">
					<ProjectButton label="All projects" sub={`${projects.length} repositories`} needs={cards.filter((c) => needsYou(c) || c.status === "abandoned").length} working={cards.filter(isLive).length} active={filter === "all"} onClick={() => pickFilter("all")} />
					{projects.map((project) => {
						const pc = cards.filter((card) => card.projectId === project.id);
						return (
							<ProjectButton
								key={project.id}
								label={project.name}
								sub={`${project.defaultBranch} · ${pc.filter((card) => card.stage !== "done").length} open`}
								needs={pc.filter((card) => needsYou(card) || card.status === "abandoned").length}
								working={pc.filter(isLive).length}
								active={filter === project.id}
								onClick={() => pickFilter(project.id)}
							/>
						);
					})}
				</div>
				<div className="legend" aria-label="What the counts mean">
					<div className="legend-row">
						<span className="badge needs" aria-hidden>
							3
						</span>
						<span className="grid gap-0">
							<span className="k">Need you</span>
							<span className="v">Plans to approve, questions, reviews</span>
						</span>
					</div>
					<div className="legend-row">
						<span className="badge working" aria-hidden>
							2
						</span>
						<span className="grid gap-0">
							<span className="k">Running</span>
							<span className="v">An agent is working on it</span>
						</span>
					</div>
				</div>
				<div className="rail-foot" aria-label="Model tiers">
					{(["planning", "building", "testing"] as const).map((stage) => (
						<button key={stage} type="button" className="tier cursor-pointer text-left" onClick={onOpenModels} title="Which model runs each stage">
							<span className="k">{stage === "planning" ? "Plan" : stage === "building" ? "Build" : "Test"}</span>
							<span className="v">{settings.data ? shortModel(settings.data.models[stage].model) : "…"}</span>
						</button>
					))}
				</div>
			</aside>
			<div className="stream" id="stream" tabIndex={-1}>
				<div className="stream-head">
					<h1>{filteredProject ? filteredProject.name : "Tower"}</h1>
					<p className="meta">
						{attention.length > 0
							? `${attention.length} ${attention.length === 1 ? "card needs" : "cards need"} you. Everything else is flying or waiting.`
							: "Nothing needs you. Agents are working; you are free."}
					</p>
				</div>

				{attention.length === 0 && (
					<div className="allclear">
						<h2>All clear.</h2>
						<p className="meta">
							You will be nudged here, in the tab title, and by notification when a card stops for you.{" "}
							{backlog.length > 0 && `${backlog.length} ${backlog.length === 1 ? "card sits" : "cards sit"} in the backlog below.`}
						</p>
					</div>
				)}

				{attention.length > 0 && (
					<section className="group needs" aria-label="Needs you">
						<div className="group-head">
							<h2>Needs you</h2>
							<span className="n">{attention.length}</span>
							<span className="line" />
						</div>
						<div className="rows">
							{attention.map((card, i) => (
								<AttentionRow key={card.id} card={card} projectName={names.get(card.projectId)} mergesLocally={projects.find((project) => project.id === card.projectId)?.hasOrigin === false} selected={card.id === selectedCardId} index={i} onOpen={onOpen} />
							))}
						</div>
					</section>
				)}

				{inFlight.length > 0 && (
					<section className="group working" aria-label="In flight">
						<div className="group-head">
							<h2>In flight</h2>
							<span className="n">{inFlight.length}</span>
							<span className="line" />
						</div>
						<div className="rows">
							{inFlight.map(([cardId, runs], i) => (
								<FlightRow key={cardId} card={cards.find((card) => card.id === cardId)} runs={runs} selected={cardId === selectedCardId} index={attention.length + i} onOpen={onOpen} />
							))}
						</div>
					</section>
				)}

				{(queued.length > 0 || backlog.length > 0) && (
					<section className="group" aria-label="Queued">
						<div className="group-head">
							<h2>Queued</h2>
							<span className="n">{queued.length + backlog.length}</span>
							<span className="line" />
						</div>
						<div className="rows">
							{backlog.map((card, i) => (
								<BacklogRow key={card.id} card={card} projectName={names.get(card.projectId)} selected={card.id === selectedCardId} index={attention.length + inFlight.length + i} onOpen={onOpen} />
							))}
							{queued.map((card, i) => (
								<QueueRow key={card.id} card={card} projectName={names.get(card.projectId)} selected={card.id === selectedCardId} index={attention.length + inFlight.length + backlog.length + i} onOpen={onOpen} />
							))}
						</div>
					</section>
				)}

				{finished.length > 0 && (
					<section className="group ok" aria-label="Landed today">
						<div className="group-head">
							<h2>Landed today</h2>
							<span className="n">{finished.length}</span>
							<span className="line" />
						</div>
						<div className="rows">
							{finished.slice(0, 6).map((card, i) => (
								<DoneRow key={card.id} card={card} projectName={names.get(card.projectId)} selected={card.id === selectedCardId} index={i} onOpen={onOpen} />
							))}
						</div>
						{finished.length > 6 && (
							<p className="meta mt-2">
								And {finished.length - 6} more — the <button type="button" onClick={() => (window.location.hash = "#board")} className={button.link}>board</button> keeps the rest (unfold Done there).
							</p>
						)}
					</section>
				)}

				{groupsUsed === 0 && (
					<div className="empty">
						<strong>No cards yet</strong>
						<span>
							Add work with <span className="kbd">n</span> or <code>/tower add</code> from any pi session.
						</span>
					</div>
				)}
			</div>
		</section>
	);
}

function EmptyBoard() {
	return (
		<div className="mx-auto flex w-full max-w-[44rem] flex-col items-start gap-5 pt-8">
			<div>
				<h2 className="text-[26px] font-semibold tracking-[-0.02em]">Your control tower is empty.</h2>
				<p className="mt-2 max-w-[52ch] text-[15px] text-slate">
					Add a git repository from this machine, then hand Tower a piece of work. It plans with a strong model, builds with a cheap one, lets your tests judge the result, and asks
					you only when a decision is yours.
				</p>
			</div>
			<NewProjectForm first />
		</div>
	);
}

/** A rail row: the project, its open count, and the two counts that matter — amber under amber, blue under blue. */
function ProjectButton({ label, sub, needs, working, active, onClick }: { label: string; sub: string; needs: number; working: number; active: boolean; onClick: () => void }) {
	return (
		<button type="button" className="proj" aria-pressed={active} onClick={onClick}>
			<span className="min-w-0">
				<span className="name truncate">{label}</span>
				<span className="sub">{sub}</span>
			</span>
			<span className="badges">
				{needs > 0 ? (
					<span className="badge needs" title={`${needs} need you`}>
						{needs}
					</span>
				) : (
					<span className="badge slot" aria-hidden />
				)}
				{working > 0 ? (
					<span className="badge working" title={`${working} running`}>
						{working}
					</span>
				) : (
					<span className="badge slot" aria-hidden />
				)}
			</span>
		</button>
	);
}

// --- card rows ---------------------------------------------------------------

interface RowProps {
	card: Card;
	projectName: string | undefined;
	/** No origin remote, so approving the feedback gate merges locally instead of opening a pull request. */
	mergesLocally?: boolean;
	selected: boolean;
	index: number;
	onOpen: (cardId: string) => void;
}

function useCardActions(card: Card) {
	const queryClient = useQueryClient();
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ["board"] });
		void queryClient.invalidateQueries({ queryKey: ["card", card.id] });
	};
	const decide = useMutation({
		mutationFn: (input: { gateId: string; decision: "approve" | "reject"; feedback?: string; done?: string }) => api.decideGate(card.id, input.gateId, input.decision, input.feedback),
		onSuccess: (_updated, input) => {
			refresh();
			if (input.done) toast(input.done);
		},
	});
	const resume = useMutation({ mutationFn: () => api.resume(card.id), onSuccess: () => (refresh(), toast("Resumed where it stopped.")) });
	const retry = useMutation({ mutationFn: (feedback?: string) => api.retry(card.id, feedback), onSuccess: () => (refresh(), toast("Running again.")) });
	return { refresh, decide, resume, retry };
}

/** The amber rows: one decision each, with the action in place so the inspector is optional. */
function AttentionRow({ card, projectName, mergesLocally, selected, index, onOpen }: RowProps) {
	const detail = useQueryCard(card.id);
	const { refresh, decide, resume, retry } = useCardActions(card);
	const [sendingBack, setSendingBack] = useState(false);
	const [note, setNote] = useState("");
	const openRow = () => onOpen(card.id);

	const { status } = describeCard(card);
	const gate = detail.data?.gates.find((g) => g.status === "pending") ?? null;
	const asked = card.status === "awaiting_input" ? (detail.data?.runs.at(-1)?.questions ?? null) : null;
	const pending = detail.isPending;

	let badge = status;
	let context = "";
	let actions: ReactNode = null;
	let expand: ReactNode = null;

	if (gate?.kind === "plan_approval") {
		badge = "Plan approval";
		context = "The plan is ready. A cheap model will build from it alone, so it has to stand on its own.";
		actions = (
			<>
				<button type="button" onClick={() => decide.mutate({ gateId: gate.id, decision: "approve", done: "Plan approved. The builder starts next." })} disabled={decide.isPending} className="btn primary sm">
					Approve &amp; build
				</button>
				<button type="button" onClick={openRow} className="btn sm">
					Read plan
				</button>
				<button type="button" onClick={() => setSendingBack((on) => !on)} className="btn ghost sm">
					Send back…
				</button>
			</>
		);
		expand =
			sendingBack && gate ? (
				<SendBack note={note} setNote={setNote} busy={decide.isPending} onSend={() => decide.mutate({ gateId: gate.id, decision: "reject", feedback: note.trim(), done: "Sent back to planning with your note." })} onCancel={() => setSendingBack(false)} />
			) : null;
	} else if (gate?.kind === "feedback") {
		badge = "Review work";
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
					? `${checks.resultSummary ?? "Checks are in."} Reviews are in. ${mergesLocally ? "Approving merges the work into the default branch." : "Approving opens the pull request."}`
					: mergesLocally
						? "The work is done and reviewed. Approving merges it into the default branch."
						: "The work is done and reviewed. Approving opens the pull request.";
		if (reports.length === 0) context = mergesLocally ? "The work is done. Approving merges it into the default branch." : "The work is done. Approving opens the pull request.";
		actions = (
			<>
				<button type="button" onClick={() => decide.mutate({ gateId: gate.id, decision: "approve", done: mergesLocally ? "Approved. Tower merges the branch." : "Approved. Tower opens the pull request." })} disabled={decide.isPending} className="btn primary sm">
					{mergesLocally ? "Approve & merge" : "Approve & open PR"}
				</button>
				<button type="button" onClick={openRow} className="btn sm">
					Read findings
				</button>
				<button type="button" onClick={() => setSendingBack((on) => !on)} className="btn ghost sm">
					Send back…
				</button>
			</>
		);
		expand =
			sendingBack && gate ? (
				<SendBack
					note={note}
					setNote={setNote}
					busy={decide.isPending}
					placeholder={reports.length > 0 ? `Address the blocking findings in ${reports.map((report) => report.name).join(" and ")}.` : "What should change?"}
					onSend={() => decide.mutate({ gateId: gate.id, decision: "reject", feedback: note.trim(), done: "Sent back to the builder with your note." })}
					onCancel={() => setSendingBack(false)}
				/>
			) : null;
	} else if (asked) {
		// One answering surface: the inspector's Decision tab. This row only previews the questions, so a pick
		// here can never silently disagree with the form the reader actually sends.
		badge = `Answer ${asked.length === 1 ? "one question" : `${asked.length} questions`}`;
		context = card.needsAttentionReason ?? `The agent stopped to ask ${asked.length === 1 ? "a question" : `${asked.length} questions`}.`;
		actions = (
			<button type="button" onClick={openRow} className="btn amber sm">
				Answer
			</button>
		);
		expand = (
			<ol className="flex list-decimal flex-col gap-1 pl-5 text-[14px] text-ink/80">
				{asked.map((q) => (
					<li key={q.question}>{q.question}</li>
				))}
			</ol>
		);
	} else if (card.status === "abandoned") {
		badge = "Needs a decision";
		context = card.needsAttentionReason ?? "This card was abandoned and went no further. Running it again starts a fresh session on the same branch.";
		actions = (
			<>
				<button type="button" onClick={() => retry.mutate()} disabled={retry.isPending} className="btn primary sm">
					Run again
				</button>
				<button type="button" onClick={openRow} className="btn sm">
					Open
				</button>
			</>
		);
	} else if (card.status === "interrupted") {
		badge = "Interrupted";
		context = "A restart cut this session off. Resume continues the same pi session where it stopped.";
		actions = (
			<>
				<button type="button" onClick={() => resume.mutate()} disabled={resume.isPending} className="btn primary sm">
					Resume
				</button>
				<button type="button" onClick={openRow} className="btn sm">
					Open
				</button>
			</>
		);
	} else {
		badge = "Needs a decision";
		context = card.needsAttentionReason ?? "The loop stopped and wants a decision.";
		if (card.stage === "testing" && card.status === "idle") {
			context = card.needsAttentionReason ?? "The build passed but the stage did not finish. Continue to the reviews.";
			actions = (
				<>
					<button type="button" onClick={() => retry.mutate()} disabled={retry.isPending} className="btn primary sm">
						Continue
					</button>
					<button type="button" onClick={openRow} className="btn sm">
						Open
					</button>
				</>
			);
		} else {
			actions = (
				<>
					<button type="button" onClick={() => retry.mutate()} disabled={retry.isPending} className="btn primary sm">
						Run again
					</button>
					<button type="button" onClick={openRow} className="btn sm">
						Open
					</button>
				</>
			);
		}
	}

	const abandoned = card.status === "abandoned";
	return (
		<article className={`card ${abandoned ? "warn" : "needs"}${selected ? " selected" : ""}`} style={{ "--i": index } as React.CSSProperties} data-id={card.id}>
			<div className="bar" />
			<div className="card-main">
				<button type="button" className="card-open" onClick={openRow} aria-label={`Open ${card.title}`}>
					<span className="title line-clamp-2">{card.title}</span>
					<span className="ctx">
						<span className="p">{projectName}</span>
						<span className="sep" />
						<span>{badge}</span>
						<span className="sep" />
						<span className="id">{card.id}</span>
					</span>
					{pending ? <span className="stakes">Reading the card…</span> : <span className="stakes">{context}</span>}
				</button>
				<div className="card-side">{actions}</div>
				{expand && <div className="inline-decision">{expand}</div>}
				{(decide.error ?? resume.error ?? retry.error) && (
					<div className="inline-decision">
						<ErrorNote error={(decide.error ?? resume.error ?? retry.error) ?? null} onRetry={refresh} />
					</div>
				)}
			</div>
		</article>
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
				<button type="button" disabled={!note.trim() || busy} onClick={onSend} className="btn primary sm">
					Send back
				</button>
				<button type="button" onClick={onCancel} className="btn ghost sm">
					Cancel
				</button>
			</div>
		</div>
	);
}

/** A card with a session running. Quiet on purpose: the agent is working, and that is not a question. */
function FlightRow({ card, runs, selected, index, onOpen }: { card: Card | undefined; runs: StageRun[]; selected: boolean; index: number; onOpen: (id: string) => void }) {
	const queryClient = useQueryClient();
	const abort = useMutation({ mutationFn: (cardId: string) => api.abort(cardId), onSuccess: () => (void queryClient.invalidateQueries({ queryKey: ["board"] }), toast("Aborted. The card waits for you.")) });
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
		<article className={`card working${selected ? " selected" : ""}`} style={{ "--i": index } as React.CSSProperties} data-id={card.id}>
			<div className="bar" />
			<div className="card-main">
				<button type="button" className="card-open" onClick={() => onOpen(card.id)} aria-label={`Open ${card.title}`}>
					<span className="title line-clamp-2">{card.title}</span>
					<span className="stakes">
						{label} · {shortModel(primary?.model)}
					</span>
				</button>
				<div className="card-side">
					<span className="chip working">
						<span className="dot working" />
						{label}
					</span>
					<span className="elapsed tnum">{elapsed}</span>
					<button type="button" onClick={() => onOpen(card.id)} className="btn ghost sm">
						Open
					</button>
					<ConfirmButton small label="Abort" confirmLabel="Confirm abort?" onConfirm={() => abort.mutate(card.id)} busy={abort.isPending} />
				</div>
			</div>
			<div className="sweep" aria-hidden />
		</article>
	);
}

/** A card told to wait for your go. Start queues it; nothing runs until then. */
function BacklogRow({ card, projectName, selected, index, onOpen }: RowProps) {
	const queryClient = useQueryClient();
	const start = useMutation({ mutationFn: () => api.enqueue(card.id), onSuccess: () => (void queryClient.invalidateQueries({ queryKey: ["board"] }), toast(`Queued “${card.title}” for planning.`)) });
	return (
		<article className={`card${selected ? " selected" : ""}`} style={{ "--i": index } as React.CSSProperties} data-id={card.id}>
			<div className="bar" />
			<div className="card-main">
				<button type="button" className="card-open" onClick={() => onOpen(card.id)} aria-label={`Open ${card.title}`}>
					<span className="title line-clamp-2">{card.title}</span>
					<span className="ctx">
						<span className="p">{projectName}</span>
						<span className="sep" />
						<span>Backlog</span>
						<span className="sep" />
						<span className="id">{card.id}</span>
					</span>
					<span className="stakes">In the backlog. Start it when you want it planned.</span>
				</button>
				<div className="card-side">
					<button type="button" onClick={() => start.mutate()} disabled={start.isPending} className="btn sm">
						<Icon name="play" />
						Start
					</button>
					<button type="button" onClick={() => onOpen(card.id)} className="btn ghost sm">
						Open
					</button>
				</div>
			</div>
		</article>
	);
}

/** Queued: planning starts as soon as a slot frees. Removing it asks twice. */
function QueueRow({ card, projectName, selected, index, onOpen }: RowProps) {
	const queryClient = useQueryClient();
	const remove = useMutation({ mutationFn: () => api.abort(card.id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board"] }) });
	return (
		<article className={`card working${selected ? " selected" : ""}`} style={{ "--i": index } as React.CSSProperties} data-id={card.id}>
			<div className="bar" />
			<div className="card-main">
				<button type="button" className="card-open" onClick={() => onOpen(card.id)} aria-label={`Open ${card.title}`}>
					<span className="title line-clamp-2">{card.title}</span>
					<span className="ctx">
						<span className="p">{projectName}</span>
						<span className="sep" />
						<span>{STAGE_LABEL[card.stage]}</span>
						<span className="sep" />
						<span className="id">{card.id}</span>
					</span>
					<span className="stakes">Waiting for a free slot</span>
				</button>
				<div className="card-side">
					<span className="chip">Queued</span>
					<button type="button" onClick={() => onOpen(card.id)} className="btn ghost sm">
						Open
					</button>
					<ConfirmButton small label="Remove from queue" confirmLabel="Confirm remove?" onConfirm={() => remove.mutate()} busy={remove.isPending} />
				</div>
			</div>
		</article>
	);
}

function DoneRow({ card, projectName, selected, index, onOpen }: RowProps) {
	// A slow tick keeps the age honest without re-rendering every second.
	useElapsed(card.updatedAt, true, 30_000);
	return (
		<article className={`card ok${selected ? " selected" : ""}`} style={{ "--i": index } as React.CSSProperties} data-id={card.id}>
			<div className="bar" />
			<div className="card-main">
				<button type="button" className="card-open" onClick={() => onOpen(card.id)} aria-label={`Open ${card.title}`}>
					<span className="title">{card.title}</span>
					<span className="ctx">
						<span className="p">{projectName}</span>
						<span className="sep" />
						<span className="id">{card.id}</span>
					</span>
				</button>
				<div className="card-side">
					{card.prUrl && (
						<a href={card.prUrl} target="_blank" rel="noreferrer noopener" className="chip ok mono">
							{card.prUrl.replace("https://github.com/", "")}
						</a>
					)}
					<span className="meta">finished {formatAgo(card.updatedAt)}</span>
				</div>
			</div>
		</article>
	);
}

// --- shared row plumbing ---------------------------------------------------

function useQueryCard(cardId: string) {
	const queries = useQueries({
		queries: [{ queryKey: ["card", cardId], queryFn: () => api.card(cardId) }],
	});
	const result = queries[0];
	return { data: result?.data as CardDetail | undefined, isPending: usePastDelay(result?.isPending ?? false) };
}

const flowName = (run: StageRun) => run.id.replace(/^c[^-]+-/, "").replace(/-\d+$/, "");

function formatAgo(at: number): string {
	const seconds = Math.max(1, Math.floor((Date.now() - at) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}
