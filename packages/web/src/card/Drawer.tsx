import type { StageRun } from "@tower/core";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { useTranscript } from "../api/stream.ts";
import { BAR_CLASS, CHIP_CLASS, describeCard, isLive } from "../board/status.ts";
import { Markdown } from "../content/Markdown.tsx";
import { ArtifactsPanel } from "./ArtifactsPanel.tsx";
import { DiffPanel } from "./DiffPanel.tsx";
import { GatePanel } from "./GatePanel.tsx";
import { SteerBox } from "./SteerBox.tsx";
import { Transcript } from "./Transcript.tsx";

interface DrawerProps {
	cardId: string;
	onClose: () => void;
	/** Tells the app which run's transcript to stream. */
	onRunOpen: (runId: string | null) => void;
}

export function Drawer({ cardId, onClose, onRunOpen }: DrawerProps) {
	const detail = useQuery({ queryKey: ["card", cardId], queryFn: () => api.card(cardId) });
	const [tab, setTab] = useState<"session" | "changes" | "files">("session");
	const [pickedRunId, setPickedRunId] = useState<string | null>(null);

	const runs = detail.data?.runs ?? [];
	// Follow the newest run unless the reader deliberately picked an older one.
	const run = runs.find((r) => r.id === pickedRunId) ?? runs.at(-1) ?? null;
	const blocks = useTranscript(run?.id ?? null);

	useEffect(() => setPickedRunId(null), [cardId]);
	useEffect(() => {
		onRunOpen(run?.id ?? null);
		return () => onRunOpen(null);
	}, [run?.id, onRunOpen]);

	if (detail.isPending) return <aside className="h-full bg-sheet p-4 text-slate">Loading card…</aside>;
	if (detail.error) return <aside className="h-full bg-sheet p-4 text-danger">{detail.error.message}</aside>;
	const { card, artifacts, gates } = detail.data;
	const pendingGate = gates.find((gate) => gate.status === "pending") ?? null;
	const { stage, status, tone } = describeCard(card);
	const live = isLive(card) && run?.id === runs.at(-1)?.id;
	const caution = tone === "caution";

	return (
		<aside aria-label={`Card ${card.title}`} className="flex h-full min-h-0 flex-col bg-sheet">
			<div aria-hidden className={`h-1 shrink-0 ${isLive(card) ? "bg-primary" : caution ? "bg-caution" : BAR_CLASS[tone]}`} />
			<header className={`shrink-0 border-b border-rule px-4 py-3 ${caution ? "bg-caution-soft" : ""}`}>
				<div className="flex items-start gap-3">
					<h2 className="min-w-0 flex-1 text-[19px] leading-snug font-bold">{card.title}</h2>
					<button type="button" onClick={onClose} className="cursor-pointer rounded px-2 py-0.5 text-[14px] text-slate hover:bg-wash hover:text-ink">
						Close
					</button>
				</div>
				<p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-slate">
					<span className={`rounded px-1.5 py-px text-[12px] font-semibold ${caution ? "bg-caution text-caution-ink" : CHIP_CLASS[tone]}`}>{status}</span>
					<span>{stage}</span>
					<span className="font-mono text-[12px]">{card.id}</span>
					{card.branchName && <span className="font-mono text-[12px] break-all">{card.branchName}</span>}
				</p>
				{card.brief && (
					<div className="mt-2 max-h-24 overflow-y-auto text-[14px]">
						<Markdown text={card.brief} />
					</div>
				)}
				{card.needsAttentionReason && <p className="mt-2 text-[14px] font-semibold">{card.needsAttentionReason}</p>}
			</header>

			<nav className="flex shrink-0 items-center gap-4 border-b border-rule px-4">
				<TabButton active={tab === "session"} onClick={() => setTab("session")}>
					Session
				</TabButton>
				<TabButton active={tab === "changes"} onClick={() => setTab("changes")}>
					Changes
				</TabButton>
				<TabButton active={tab === "files"} onClick={() => setTab("files")}>
					Files <span className="text-slate">{artifacts.length}</span>
				</TabButton>
				{tab === "session" && runs.length > 1 && (
					<select aria-label="Session to show" value={run?.id ?? ""} onChange={(event) => setPickedRunId(event.target.value)} className="ml-auto rounded border border-rule bg-sheet px-2 py-1 text-[13px]">
						{runs.map((r) => (
							<option key={r.id} value={r.id}>
								{r.kind === "verify" ? "verify command" : r.stage} {r.attempt}
							</option>
						))}
					</select>
				)}
			</nav>

			{tab === "files" ? (
				<ArtifactsPanel cardId={card.id} artifacts={artifacts} />
			) : tab === "changes" ? (
				<DiffPanel cardId={card.id} refreshKey={card.updatedAt} />
			) : pendingGate?.kind === "plan_approval" ? (
				<GatePanel cardId={card.id} gate={pendingGate} />
			) : run ? (
				<>
					<RunSummary run={run} />
					<Transcript blocks={blocks} live={live} />
					{live && run.kind !== "verify" && <SteerBox cardId={card.id} />}
				</>
			) : (
				<p className="p-4 text-[14px] text-slate">No session has run for this card yet. Choose Start on its strip to plan it.</p>
			)}
		</aside>
	);
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`-mb-px cursor-pointer border-b-2 py-2 text-[14px] font-semibold ${active ? "border-primary text-ink" : "border-transparent text-slate hover:text-ink"}`}
		>
			{children}
		</button>
	);
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
