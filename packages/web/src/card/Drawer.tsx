import type { Project, StageRun } from "@tower/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../api/client.ts";
import { useTranscript } from "../api/stream.ts";
import { describeCard, isLive, TONE_SUFFIX } from "../board/status.ts";
import { ConfirmButton, ErrorNote, formatMoney, formatTokens } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { Markdown } from "../content/Markdown.tsx";
import { ArtifactsPanel } from "./ArtifactsPanel.tsx";
import { DiffPanel } from "./DiffPanel.tsx";
import { FeedbackPanel } from "./FeedbackPanel.tsx";
import { BudgetGatePanel } from "./BudgetGatePanel.tsx";
import { GatePanel } from "./GatePanel.tsx";
import { QuestionsPanel } from "./QuestionsPanel.tsx";
import { RunPanel } from "./RunPanel.tsx";
import { Activity } from "./Activity.tsx";
import { SteerBox } from "./SteerBox.tsx";
import { Transcript } from "./Transcript.tsx";

interface DrawerProps {
	cardId: string;
	projects: Project[];
	onClose: () => void;
	/** Tells the app which run's transcript to stream. */
	onRunOpen: (runId: string | null) => void;
}

type Tab = "decision" | "session" | "changes" | "files" | "activity" | "run";

/**
 * The card inspector: one surface docked beside whichever view is active. When the card is waiting
 * for the reader, the decision is the first tab and it is selected; the session, the diff and the
 * files are one click away.
 */
export function Drawer({ cardId, projects, onClose, onRunOpen }: DrawerProps) {
	const detail = useQuery({ queryKey: ["card", cardId], queryFn: () => api.card(cardId) });
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<Tab | null>(null);
	const [pickedRunId, setPickedRunId] = useState<string | null>(null);

	const runs: StageRun[] = detail.data?.runs ?? [];
	// Follow the newest run unless the reader deliberately picked an older one.
	const run = runs.find((r) => r.id === pickedRunId) ?? runs.at(-1) ?? null;
	const blocks = useTranscript(run?.id ?? null);
	const heading = useRef<HTMLHeadingElement>(null);
	const abort = useMutation({
		mutationFn: (cardId: string) => api.abort(cardId),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board"] }),
	});
	const remove = useMutation({
		mutationFn: (cardId: string) => api.deleteCard(cardId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["board"] });
			onClose();
		},
	});

	const pendingGate = detail.data?.gates.find((gate) => gate.status === "pending") ?? null;
	// The run that asked is not always the newest one — a crew's blocked builder may sit a few runs back.
	const asked = detail.data?.card.status === "awaiting_input" ? (runs.findLast((r) => r.questions)?.questions ?? null) : null;
	const decision = pendingGate !== null || asked !== null;

	useEffect(() => {
		setPickedRunId(null);
		setTab(null);
	}, [cardId]);
	// A decision arriving while the drawer is open pulls the reader to it, once.
	const [sawDecision, setSawDecision] = useState(false);
	useEffect(() => {
		if (decision && !sawDecision) {
			setSawDecision(true);
			setTab("decision");
		}
		if (!decision && sawDecision) setSawDecision(false);
	}, [decision, sawDecision]);

	// Opening the drawer is a change of place: put the reader's focus on the card's name.
	useEffect(() => {
		heading.current?.focus();
	}, [cardId]);
	// Escape leaves the drawer — unless a dialog is open on top of it, which closes itself first.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.querySelector('[role="dialog"]')) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const runId = run?.id ?? null;
	useEffect(() => {
		onRunOpen(runId);
		return () => onRunOpen(null);
	}, [runId, onRunOpen]);

	if (detail.isPending)
		return (
			<aside aria-label="Card" className="inspector open">
				<div className="insp-empty">Loading card…</div>
			</aside>
		);
	if (detail.error)
		return (
			<aside aria-label="Card" className="inspector open">
				<div className="panel">
					<ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />
				</div>
			</aside>
		);
	if (!detail.data) return null;
	const { card, artifacts, annotations } = detail.data;
	const removable = (card.stage === "done" || card.stage === "backlog") && card.status === "idle";
	const project = projects.find((p) => p.id === card.projectId);
	const { stage, status, tone } = describeCard(card);
	const live = run?.id === runs.at(-1)?.id && (isLive(card) || run?.status === "running" || run?.status === "starting");
	// A crew runs several sessions at once; steering one of them from the drawer would mislead the reader.
	const crewLive = runs.some((r) => r.kind === "subagent" && (r.status === "running" || r.status === "starting"));
	const caution = tone === "caution";
	const totals = runs.reduce((sum, r) => ({ tokens: sum.tokens + (r.tokens?.total ?? 0), cost: sum.cost + (r.costUsd ?? 0) }), { tokens: 0, cost: 0 });
	const sessions = runs.filter((r) => r.kind !== "verify").length;
	const usage = totals.tokens > 0 ? `${formatTokens(totals.tokens)} tok · ${sessions} ${sessions === 1 ? "session" : "sessions"}${totals.cost > 0 ? ` · ${formatMoney(totals.cost)}` : ""}` : null;
	// The spend against the project's per-card budget, while the card runs — the gate is too late
	// to be the first place a person learns what a card costs.
	const budget = detail.data?.spend.budgetUsd ?? null;
	const meter = budget ? ` · $${totals.cost.toFixed(2)} of $${budget.toFixed(2)} budget` : null;

	// A decision that resolved while the reader watched another tab leaves no empty pane behind.
	const chosen: Tab = tab ?? (decision ? "decision" : "session");
	const activeTab: Tab = chosen === "decision" && !decision ? "session" : chosen;
	const tabs: Array<{ id: Tab; label: ReactNode; tone?: "caution" }> = [
		...(decision ? [{ id: "decision" as Tab, label: "Decision" as ReactNode, tone: "caution" as const }] : []),
		{ id: "session" as Tab, label: "Session" },
		{ id: "changes" as Tab, label: "Changes" },
		{ id: "files" as Tab, label: <>Files <span className="text-slate">{artifacts.length}</span></> },
		{ id: "activity" as Tab, label: "Activity" },
		{ id: "run" as Tab, label: "Run" },
	];
	const onTabArrow = (event: React.KeyboardEvent) => {
		if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
		event.preventDefault();
		const index = tabs.findIndex((t) => t.id === activeTab);
		const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
		if (!next) return;
		setTab(next.id);
		// Roving focus follows the selection, so the next Tab press starts from the new tab.
		requestAnimationFrame(() => document.getElementById(`drawer-tab-${next.id}`)?.focus());
	};

	return (
		<aside aria-label={`Card ${card.title}`} className="inspector open">
			<header className="insp-head">
				<div className="top">
					<h2 ref={heading} tabIndex={-1} className="min-w-0 flex-1 outline-none">
						{card.title}
					</h2>
					<button type="button" onClick={onClose} className="iconbtn insp-close" aria-label="Close">
						<Icon name="x" className="icon icon-lg" />
					</button>
				</div>
				<div className="ctx">
					<strong>{project?.name}</strong>
					{card.branchName && (
						<span className="mono flex min-w-0 items-center gap-1" title={card.branchName}>
							<Icon name="branch" />
							<span className="max-w-[16rem] truncate">{card.branchName}</span>
						</span>
					)}
					<span className="mono">{card.id}</span>
					{usage && <span className="mono">{usage}{meter}</span>}
				</div>
				<div className="toolbar">
					<span className={`chip ${caution ? "needs" : TONE_SUFFIX[tone]}`}>{status}</span>
					<span className="meta">{stage}</span>
					{card.prUrl && (
						<a href={card.prUrl} target="_blank" rel="noreferrer noopener" className="chip mono ok">
							<Icon name="pr" />
							{card.prUrl.replace("https://github.com/", "")}
						</a>
					)}
					{card.issueUrl && card.issueNumber !== null && (
						<a href={card.issueUrl} target="_blank" rel="noreferrer noopener" className="chip mono" title="This card came from a GitHub issue on the feedback repo">
							<Icon name="issue" />
							issue #{card.issueNumber}
						</a>
					)}
					<span className="spacer" />
					{isLive(card) && <ConfirmButton small label="Abort" confirmLabel="Confirm abort?" onConfirm={() => abort.mutate(card.id)} busy={abort.isPending} />}
					{removable && <ConfirmButton small label="Delete" confirmLabel="Delete from the board?" onConfirm={() => remove.mutate(card.id)} busy={remove.isPending} />}
				</div>
				{card.brief && (
					<details className="text-[14px]">
						<summary className="cursor-pointer text-[13px] text-slate select-none">The brief</summary>
						<div className="mt-1 max-h-32 overflow-y-auto">
							<Markdown text={card.brief} />
						</div>
					</details>
				)}
				{card.needsAttentionReason && card.status !== "awaiting_input" && <p className="text-[14px] font-semibold">{card.needsAttentionReason}</p>}
				{card.baseCardId && (
					<p className="text-[13px] text-slate">
						Stacked on card <span className="font-mono">{card.baseCardId}</span> — this branch started from that card's branch.
					</p>
				)}
				{card.dependsOn && (
					<p className="text-[13px] text-slate">
						Waits for card <span className="font-mono">{card.dependsOn}</span> to land before it takes a slot.
					</p>
				)}
				{card.stage === "done" && card.finishNote && (
					<p className="text-[14px] text-slate">
						<span className="mr-1.5 inline-block size-2 rounded-full bg-ok align-middle" aria-hidden />
						{card.finishNote}
					</p>
				)}
			</header>

			<nav className="tabs" role="tablist" aria-label="Card sections" onKeyDown={onTabArrow}>
				{tabs.map(({ id, label, tone }) => (
					<TabButton key={id} id={id} active={activeTab === id} onSelect={() => setTab(id)} tone={tone}>
						{label}
					</TabButton>
				))}
			</nav>

			<div key={activeTab} role="tabpanel" id={`drawer-panel-${activeTab}`} aria-labelledby={`drawer-tab-${activeTab}`} tabIndex={0} className="flex min-h-0 flex-col outline-none">
				{activeTab === "files" ? (
					<ArtifactsPanel cardId={card.id} artifacts={artifacts} annotations={annotations} />
				) : activeTab === "activity" ? (
					<Activity card={card} runs={runs} gates={detail.data.gates} />
				) : activeTab === "changes" ? (
					<DiffPanel cardId={card.id} refreshKey={card.updatedAt} />
				) : activeTab === "run" ? (
					<RunPanel cardId={card.id} project={project} hasWorktree={!!card.worktreePath} bench={detail.data.bench.preview} busy={isLive(card) || card.status === "queued"} onStarted={() => (setPickedRunId(null), setTab("session"))} />
				) : activeTab === "decision" && pendingGate?.kind === "plan_approval" ? (
					<GatePanel cardId={card.id} gate={pendingGate} annotations={annotations} />
				) : activeTab === "decision" && pendingGate?.kind === "budget" ? (
					<BudgetGatePanel cardId={card.id} gate={pendingGate} />
				) : activeTab === "decision" && pendingGate?.kind === "feedback" ? (
					<FeedbackPanel cardId={card.id} gate={pendingGate} runs={runs} artifacts={artifacts} annotations={annotations} mergesLocally={project?.hasOrigin === false} />
				) : activeTab === "decision" && asked ? (
					<QuestionsPanel cardId={card.id} summary={card.needsAttentionReason} questions={asked} className="flex min-h-0 flex-1 flex-col" />
				) : run ? (
					<>
						<RunsRail runs={runs} picked={run.id} onPick={setPickedRunId} />
						<RunSummary run={run} />
						<Transcript blocks={blocks} live={live} runId={run.id} />
						{live && !crewLive && run.kind !== "verify" && run.kind !== "test" && <SteerBox cardId={card.id} />}
					</>
				) : (
					<p className="p-4 text-[14px] text-slate">No session has run for this card yet. Start it from the Tower view to plan it.</p>
				)}
			</div>
		</aside>
	);
}

function TabButton({ id, active, onSelect, tone, children }: { id: string; active: boolean; onSelect: () => void; tone?: "caution"; children: ReactNode }) {
	return (
		<button
			type="button"
			role="tab"
			id={`drawer-tab-${id}`}
			aria-selected={active}
			aria-controls={`drawer-panel-${id}`}
			tabIndex={active ? 0 : -1}
			onClick={onSelect}
			style={tone === "caution" && active ? { borderBottomColor: "var(--caution)" } : undefined}
		>
			{children}
			{tone === "caution" && <span className="dot needs" aria-hidden />}
		</button>
	);
}

/**
 * Every session the card has had, as a labelled row of underline tabs — the same tab language as the
 * inspector's own tabs, so it reads as "click to switch the transcript", not as status chips. The
 * newest is picked unless the reader says otherwise.
 */
function RunsRail({ runs, picked, onPick }: { runs: StageRun[]; picked: string; onPick: (id: string) => void }) {
	// The row wraps when a card has many sessions, so no session hides behind a scroll; the picked
	// tab must still come into view for a reader who landed on a long rail (block/inline nearest: no jump).
	useEffect(() => {
		document.getElementById(`run-tab-${picked}`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
	}, [picked]);
	const onArrow = (event: React.KeyboardEvent) => {
		if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		const index = runs.findIndex((r) => r.id === picked);
		const next =
			event.key === "ArrowRight" ? (index + 1) % runs.length
			: event.key === "ArrowLeft" ? (index - 1 + runs.length) % runs.length
			: event.key === "Home" ? 0
			: runs.length - 1;
		const run = runs[next];
		if (!run || run.id === picked) return;
		onPick(run.id);
		// Roving focus follows the selection, so the next arrow press continues from the new tab.
		requestAnimationFrame(() => document.getElementById(`run-tab-${run.id}`)?.focus());
	};
	return (
		<div role="tablist" aria-label="Sessions on this card" className="flex shrink-0 items-stretch gap-3 border-b border-rule bg-sheet px-4" onKeyDown={onArrow}>
			<span className="label flex shrink-0 items-center !text-[11px]">Sessions</span>
			<div className="flex flex-wrap items-stretch gap-x-1 gap-y-0">
				{runs.map((r) => {
					const state = r.status === "running" || r.status === "starting" ? "live" : r.resultStatus === "pass" ? "pass" : r.resultStatus === "fail" ? "fail" : r.status === "aborted" ? "stop" : r.error ? "fail" : "rest";
					const dot = { live: "bg-primary pulse", pass: "bg-ok", fail: "bg-danger", stop: "bg-rule", rest: "bg-rule" }[state];
					const active = r.id === picked;
					return (
						<button
							key={r.id}
							type="button"
							role="tab"
							id={`run-tab-${r.id}`}
							aria-selected={active}
							tabIndex={active ? 0 : -1}
							onClick={() => onPick(r.id)}
							className={`-mb-px flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-2 pt-2 text-[13px] ${active ? "border-primary text-ink" : "border-transparent text-slate hover:border-rule-strong hover:text-ink"}`}
						>
							<span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
							{runLabel(r)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

function runLabel(run: StageRun): string {
	if (run.kind === "verify") return "your checks";
	if (run.kind === "test") return `your tests${run.attempt > 1 ? ` ${run.attempt}×` : ""}`;
	if (run.kind === "flow_step") return run.id.replace(/^c[^-]+-/, "").replace(/-\d+$/, "").replaceAll("-", " ");
	if (run.kind === "subagent") {
		const member = run.id.replace(/^c[^-]+-crew\d+-/, "");
		if (member.startsWith("scout-")) return `scout ${member.replace("scout-", "").replaceAll("-", " ")}`;
		if (member.startsWith("ws-")) return `builder ${member.replace("ws-", "").replaceAll("-", " ")}`;
		return member.replaceAll("-", " ");
	}
	if (run.kind === "stage") return `${run.model === "crew" ? "crew" : run.stage}${run.attempt > 1 ? ` ${run.attempt}×` : ""}`;
	return run.id.replace(/^c[^-]+-/, "").replaceAll("-", " ");
}

const RESULT_CHIP: Record<string, string> = { pass: "bg-ok-soft text-ok", fail: "bg-danger-soft text-danger", blocked: "bg-caution-soft text-ink", missing: "bg-caution-soft text-ink" };

function RunSummary({ run }: { run: StageRun }) {
	const tokens = run.tokens ? `${run.tokens.total.toLocaleString()} tokens` : null;
	// Subscription models report $0, so tokens lead and dollars only show when there is a real figure.
	const cost = run.costUsd ? formatMoney(run.costUsd) : null;
	// A deterministic flow step records its command as the "model"; "thinking off" after a shell pipeline reads as noise.
	const commandStep = run.kind === "flow_step" && (run.args[0] === "pass" || run.args[0] === "note");
	return (
		<div className="shrink-0 border-b border-rule bg-sheet px-4 py-2 text-[13px] text-slate">
			<p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
				{run.kind === "verify" || run.kind === "test" ? (
					<span>
						{run.kind === "verify" ? "Verify command" : "Test command"} <span className="font-mono text-ink">{run.model}</span>
					</span>
				) : commandStep ? (
					<span>
						Step command <span className="font-mono text-ink">{run.model}</span>
					</span>
				) : run.model === "crew" ? (
					<span>one building attempt, run by a crew of sub-agents</span>
				) : (
					<span>
						<span className="font-mono text-ink">{run.model}</span> thinking {run.thinking}
					</span>
				)}
				{tokens && <span className="tnum">{tokens}</span>}
				{cost && <span className="tnum">{cost}</span>}
			</p>
			{run.resultSummary && (
				<p className="mt-1 text-ink">
					{run.resultStatus && <span className={`mr-2 rounded px-1.5 py-px text-[12px] font-semibold ${RESULT_CHIP[run.resultStatus] ?? ""}`}>{run.resultStatus}</span>}
					{run.resultSummary}
				</p>
			)}
			{run.error && <p className="mt-1 text-danger">{run.error}</p>}
		</div>
	);
}
