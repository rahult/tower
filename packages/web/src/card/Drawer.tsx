import type { StageRun } from "@traffic-control/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { useTranscript } from "../api/stream.ts";
import { describeCard, isLive, TINT_CLASS } from "../board/status.ts";
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

	if (detail.isPending) return <aside className="bg-rack p-4 text-dust">Loading card…</aside>;
	if (detail.error) return <aside className="bg-rack p-4 text-rose">{detail.error.message}</aside>;
	const { card, artifacts, gates } = detail.data;
	const pendingGate = gates.find((gate) => gate.status === "pending") ?? null;
	const { stage, status, tint } = describeCard(card);
	const live = isLive(card) && run?.id === runs.at(-1)?.id;

	return (
		<aside aria-label={`Card ${card.title}`} className="flex h-full min-h-0 flex-col bg-rack">
			<header className={`${TINT_CLASS[tint]} px-4 py-3 text-ink`}>
				<div className="flex items-start gap-3">
					<h2 className="min-w-0 flex-1 text-[19px] leading-snug font-semibold">{card.title}</h2>
					<button type="button" onClick={onClose} className="cursor-pointer text-[14px] underline underline-offset-4">
						Close
					</button>
				</div>
				<p className="condensed mt-1 text-[14px]">
					<span className="font-mono text-[13px]">{card.id}</span>, {stage.toLowerCase()}, <span className="font-semibold">{status.toLowerCase()}</span>
				</p>
				{card.needsAttentionReason && <p className="mt-1 text-[14px]">{card.needsAttentionReason}</p>}
				{card.branchName && <p className="mt-1 font-mono text-[12px] break-all text-ink/70">{card.branchName}</p>}
			</header>

			<nav className="flex items-center gap-1 border-b border-seam px-3 pt-2">
				<TabButton active={tab === "session"} onClick={() => setTab("session")}>
					Session
				</TabButton>
				<TabButton active={tab === "changes"} onClick={() => setTab("changes")}>
					Changes
				</TabButton>
				<TabButton active={tab === "files"} onClick={() => setTab("files")}>
					Files ({artifacts.length})
				</TabButton>
				{tab === "session" && runs.length > 1 && (
					<select
						aria-label="Session to show"
						value={run?.id ?? ""}
						onChange={(event) => setPickedRunId(event.target.value)}
						className="ml-auto mb-1 rounded-[3px] bg-well px-2 py-1 text-[13px]"
					>
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
				<p className="p-4 text-[14px] text-dust">No session has run for this card yet. Choose Start on its strip to plan it.</p>
			)}
		</aside>
	);
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`cursor-pointer rounded-t-[3px] px-3 py-1.5 text-[14px] ${active ? "bg-well font-semibold text-chalk" : "text-dust hover:text-chalk"}`}
		>
			{children}
		</button>
	);
}

function RunSummary({ run }: { run: StageRun }) {
	const tokens = run.tokens ? `${run.tokens.total.toLocaleString()} tokens` : null;
	// Plan-based models report $0, so tokens lead and dollars only show when there is a real figure.
	const cost = run.costUsd ? `$${run.costUsd.toFixed(run.costUsd < 1 ? 3 : 2)}` : null;
	return (
		<div className="border-b border-seam px-4 py-2 text-[13px] text-dust">
			<p>
				{run.kind === "verify" ? (
					<>
						Verify command <span className="font-mono text-chalk">{run.model}</span>
					</>
				) : (
					<>
						<span className="font-mono text-chalk">{run.model}</span> thinking {run.thinking}
					</>
				)}
				{tokens && <>, {tokens}</>}
				{cost && <>, {cost}</>}
			</p>
			{run.resultSummary && (
				<p className="mt-0.5 text-chalk">
					Result {run.resultStatus}: {run.resultSummary}
				</p>
			)}
			{run.error && <p className="mt-0.5 text-rose">{run.error}</p>}
		</div>
	);
}
