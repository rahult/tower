import type { Project, StageRun } from "@tower/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { useTranscript } from "../api/stream.ts";
import { BAR_CLASS, CHIP_CLASS, describeCard, isLive } from "../board/status.ts";
import { Markdown } from "../content/Markdown.tsx";
import { ArtifactsPanel } from "./ArtifactsPanel.tsx";
import { DiffPanel } from "./DiffPanel.tsx";
import { FeedbackPanel } from "./FeedbackPanel.tsx";
import { GatePanel } from "./GatePanel.tsx";
import { QuestionsPanel } from "./QuestionsPanel.tsx";
import { RunPanel } from "./RunPanel.tsx";
import { SteerBox } from "./SteerBox.tsx";
import { Transcript } from "./Transcript.tsx";

interface DrawerProps {
	cardId: string;
	projects: Project[];
	onClose: () => void;
	/** Tells the app which run's transcript to stream. */
	onRunOpen: (runId: string | null) => void;
}

type Tab = "decision" | "session" | "changes" | "files" | "run";

/**
 * The card's whole story, with the decision on top: when the card is waiting for the reader, the decision
 * is the first tab and it is selected; the session, the diff and the files are one click away.
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
	const abort = useMutation({
		mutationFn: (cardId: string) => api.abort(cardId),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board"] }),
	});

	const pendingGate = detail.data?.gates.find((gate) => gate.status === "pending") ?? null;
	const asked = detail.data?.card.status === "awaiting_input" ? (runs.at(-1)?.questions ?? null) : null;
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

	const runId = run?.id ?? null;
	useEffect(() => {
		onRunOpen(runId);
		return () => onRunOpen(null);
	}, [runId, onRunOpen]);

	if (detail.isPending) return <aside className="h-full bg-sheet p-4 text-slate">Loading card…</aside>;
	if (detail.error) return <aside className="h-full bg-sheet p-4 text-danger">{detail.error.message}</aside>;
	if (!detail.data) return null;
	const { card, artifacts } = detail.data;
	const project = projects.find((p) => p.id === card.projectId);
	const { stage, status, tone } = describeCard(card);
	const live = run?.id === runs.at(-1)?.id && (isLive(card) || run?.status === "running" || run?.status === "starting");
	const caution = tone === "caution";
	const totals = runs.reduce((sum, r) => ({ tokens: sum.tokens + (r.tokens?.total ?? 0), cost: sum.cost + (r.costUsd ?? 0) }), { tokens: 0, cost: 0 });
	const sessions = runs.filter((r) => r.kind !== "verify").length;
	const usage = totals.tokens > 0 ? `${totals.tokens.toLocaleString()} tokens across ${sessions} ${sessions === 1 ? "session" : "sessions"}${totals.cost > 0 ? `, $${totals.cost.toFixed(2)}` : ""}` : null;

	// A decision that resolved while the reader watched another tab leaves no empty pane behind.
	const chosen: Tab = tab ?? (decision ? "decision" : "session");
	const activeTab: Tab = chosen === "decision" && !decision ? "session" : chosen;

	return (
		<aside aria-label={`Card ${card.title}`} className="flex h-full min-h-0 flex-col bg-sheet">
			<div aria-hidden className={`h-1 shrink-0 ${isLive(card) ? "bg-primary" : caution ? "bg-caution" : BAR_CLASS[tone]}`} />
			<header className={`shrink-0 border-b border-rule px-4 py-3 ${caution ? "bg-caution-soft" : ""}`}>
				<div className="flex items-start gap-3">
					<h2 className="min-w-0 flex-1 text-[19px] leading-snug font-bold">{card.title}</h2>
					{isLive(card) && (
						<button type="button" onClick={() => abort.mutate(card.id)} disabled={abort.isPending} className="cursor-pointer rounded-md border border-danger/40 bg-sheet px-2 py-1 text-[13px] font-semibold text-danger hover:bg-danger-soft">
							Abort
						</button>
					)}
					<button type="button" onClick={onClose} className="cursor-pointer rounded px-2 py-0.5 text-[14px] text-slate hover:bg-wash hover:text-ink">
						Close
					</button>
				</div>
				<p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-slate">
					<span className={`rounded px-1.5 py-px text-[12px] font-semibold ${caution ? "bg-caution text-caution-ink" : CHIP_CLASS[tone]}`}>{status}</span>
					{project?.name}
					<span aria-hidden>·</span>
					<span>{stage}</span>
					{card.branchName && (
						<>
							<span aria-hidden>·</span>
							<span className="max-w-[17rem] truncate font-mono text-[12px] align-bottom" title={card.branchName}>
								{card.branchName}
							</span>
						</>
					)}
					<span className="font-mono text-[12px] text-slate/70">{card.id}</span>
				</p>
				{card.brief && (
					<details className="mt-2 text-[14px]">
						<summary className="cursor-pointer text-[13px] text-slate select-none">The brief</summary>
						<div className="mt-1 max-h-32 overflow-y-auto">
							<Markdown text={card.brief} />
						</div>
					</details>
				)}
				{card.prUrl && (
					<p className="mt-2 text-[14px]">
						<a href={card.prUrl} target="_blank" rel="noreferrer noopener" className="font-semibold text-primary underline underline-offset-4">
							{card.prUrl.replace("https://github.com/", "")}
						</a>
						{card.stage === "pull_request" && card.status === "idle" && <span className="text-slate"> is open. Tower checks it every couple of minutes.</span>}
					</p>
				)}
				{usage && <p className="mt-1 text-[12px] text-slate">{usage}</p>}
				{card.needsAttentionReason && card.status !== "awaiting_input" && <p className="mt-2 text-[14px] font-semibold">{card.needsAttentionReason}</p>}
			</header>

			<nav className="flex shrink-0 items-center gap-4 overflow-x-auto border-b border-rule px-4">
				{decision && (
					<TabButton active={activeTab === "decision"} onClick={() => setTab("decision")} tone="caution">
						Decision
					</TabButton>
				)}
				<TabButton active={activeTab === "session"} onClick={() => setTab("session")}>
					Session
				</TabButton>
				<TabButton active={activeTab === "changes"} onClick={() => setTab("changes")}>
					Changes
				</TabButton>
				<TabButton active={activeTab === "files"} onClick={() => setTab("files")}>
					Files <span className="text-slate">{artifacts.length}</span>
				</TabButton>
				{card.worktreePath && (
					<TabButton active={activeTab === "run"} onClick={() => setTab("run")}>
						Run
					</TabButton>
				)}
			</nav>

			{activeTab === "files" ? (
				<ArtifactsPanel cardId={card.id} artifacts={artifacts} />
			) : activeTab === "changes" ? (
				<DiffPanel cardId={card.id} refreshKey={card.updatedAt} />
			) : activeTab === "run" ? (
				<RunPanel cardId={card.id} busy={isLive(card) || card.status === "queued"} onStarted={() => (setPickedRunId(null), setTab("session"))} />
			) : activeTab === "decision" && pendingGate?.kind === "plan_approval" ? (
				<GatePanel cardId={card.id} gate={pendingGate} />
			) : activeTab === "decision" && pendingGate?.kind === "feedback" ? (
				<FeedbackPanel cardId={card.id} gate={pendingGate} runs={runs} artifacts={artifacts} />
			) : activeTab === "decision" && asked ? (
				<QuestionsPanel cardId={card.id} summary={card.needsAttentionReason} questions={asked} className="flex min-h-0 flex-1 flex-col" />
			) : run ? (
				<>
					<RunsRail runs={runs} picked={run.id} onPick={setPickedRunId} />
					<RunSummary run={run} />
					<Transcript blocks={blocks} live={live} runId={run.id} />
					{live && run.kind !== "verify" && <SteerBox cardId={card.id} />}
				</>
			) : (
				<p className="p-4 text-[14px] text-slate">No session has run for this card yet. Start it from the Focus view to plan it.</p>
			)}
		</aside>
	);
}

function TabButton({ active, onClick, tone, children }: { active: boolean; onClick: () => void; tone?: "caution"; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`-mb-px cursor-pointer border-b-2 py-2 text-[14px] font-semibold whitespace-nowrap ${active ? (tone === "caution" ? "border-caution text-ink" : "border-primary text-ink") : "border-transparent text-slate hover:text-ink"}`}
		>
			{children}
		</button>
	);
}

/** Every session the card has had, as one row of chips. The newest is picked unless the reader says otherwise. */
function RunsRail({ runs, picked, onPick }: { runs: StageRun[]; picked: string; onPick: (id: string) => void }) {
	if (runs.length <= 1) return null;
	return (
		<div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-rule bg-wash px-4 py-1.5">
			{runs.map((r) => {
				const state = r.status === "running" || r.status === "starting" ? "live" : r.resultStatus === "pass" ? "pass" : r.resultStatus === "fail" ? "fail" : r.status === "aborted" ? "stop" : r.error ? "fail" : "rest";
				const dot = { live: "bg-primary pulse", pass: "bg-ok", fail: "bg-danger", stop: "bg-rule", rest: "bg-rule" }[state];
				return (
					<button
						key={r.id}
						type="button"
						onClick={() => onPick(r.id)}
						aria-pressed={r.id === picked}
						className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12.5px] whitespace-nowrap ${r.id === picked ? "border-primary bg-primary-soft font-semibold" : "border-rule bg-sheet text-slate hover:text-ink"}`}
					>
						<span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
						{runLabel(r)}
					</button>
				);
			})}
		</div>
	);
}

function runLabel(run: StageRun): string {
	if (run.kind === "verify") return "your checks";
	if (run.kind === "flow_step") return run.id.replace(/^c[^-]+-/, "").replace(/-\d+$/, "").replaceAll("-", " ");
	if (run.kind === "stage") return `${run.stage}${run.attempt > 1 ? ` ${run.attempt}×` : ""}`;
	return run.id.replace(/^c[^-]+-/, "").replaceAll("-", " ");
}

const RESULT_CHIP: Record<string, string> = { pass: "bg-ok-soft text-ok", fail: "bg-danger-soft text-danger", blocked: "bg-caution-soft text-ink", missing: "bg-caution-soft text-ink" };

function RunSummary({ run }: { run: StageRun }) {
	const tokens = run.tokens ? `${run.tokens.total.toLocaleString()} tokens` : null;
	// Subscription models report $0, so tokens lead and dollars only show when there is a real figure.
	const cost = run.costUsd ? `$${run.costUsd.toFixed(run.costUsd < 1 ? 3 : 2)}` : null;
	return (
		<div className="shrink-0 border-b border-rule bg-sheet px-4 py-2 text-[13px] text-slate">
			<p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
				{run.kind === "verify" ? (
					<span>
						Verify command <span className="font-mono text-ink">{run.model}</span>
					</span>
				) : (
					<span>
						<span className="font-mono text-ink">{run.model}</span> thinking {run.thinking}
					</span>
				)}
				{tokens && <span>{tokens}</span>}
				{cost && <span>{cost}</span>}
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
