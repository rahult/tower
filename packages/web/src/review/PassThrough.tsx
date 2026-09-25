import type { Card, Project } from "@tower/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type GateInfo } from "../api/client.ts";
import { formatMoney, formatTokens } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { toast } from "../app/toasts.tsx";

/**
 * Pass-through review: the two human gates — plan approval and the feedback gate — are the whole
 * person's job in a healthy pipeline, so this view carries just them, one big row each, readable
 * and answerable from a phone. A send-back is still the deliberate control: it wants a written note.
 * Budget gates keep their dedicated panel on the board; questions want typed answers, not a tap.
 */
export function PassThrough({ gates, projects, cards, onOpen }: { gates: GateInfo[]; projects: Project[]; cards: Card[]; onOpen: (cardId: string) => void }) {
	const answerable = gates.filter((gate) => gate.kind === "plan_approval" || gate.kind === "feedback");
	const nameOf = (projectId: string) => projects.find((project) => project.id === projectId)?.name ?? "?";

	return (
		<div className="mx-auto w-full max-w-xl px-4 py-6">
			<header className="mb-4">
				<h1 className="text-[22px] font-semibold tracking-tight">Pass-through review</h1>
				<p className="mt-1 text-[14px] text-slate">
					{answerable.length === 0
						? "Nothing is waiting on you. When a plan or a finished card needs a decision, it shows here — answerable from a phone."
						: `${answerable.length} ${answerable.length === 1 ? "decision waits" : "decisions wait"} on you. Approve to unblock the agent; a send-back wants a note.`}
				</p>
			</header>
			{answerable.length === 0 ? (
				<div className="rounded-lg border border-rule bg-wash/40 p-8 text-center">
					<Icon name="check" className="icon icon-lg mx-auto text-ok" />
					<p className="mt-2 text-[15px] font-medium">All clear</p>
					<p className="mt-1 text-[13px] text-slate">The agents are flying; the tower is quiet.</p>
				</div>
			) : (
				<ul className="grid gap-3">
					{answerable.map((gate) => {
						const card = cards.find((candidate) => candidate.id === gate.cardId);
						return <GateRow key={gate.id} gate={gate} card={card} projectName={card ? nameOf(card.projectId) : ""} onOpen={onOpen} />;
					})}
				</ul>
			)}
		</div>
	);
}

const KIND: Record<GateInfo["kind"], string> = { plan_approval: "Plan approval", feedback: "Review", budget: "Budget" };

function GateRow({ gate, card, projectName, onOpen }: { gate: GateInfo; card: Card | undefined; projectName: string; onOpen: (cardId: string) => void }) {
	const queryClient = useQueryClient();
	const [sendingBack, setSendingBack] = useState(false);
	const [note, setNote] = useState("");
	// The plan itself, or the review verdicts, tell the reader what they are approving — fetched once,
	// because "approve from a phone" still means reading what you are approving.
	const detail = useQuery({ queryKey: ["card", gate.cardId], queryFn: () => api.card(gate.cardId), staleTime: 10_000 });
	const runs = detail.data?.runs ?? [];
	const checks = runs.findLast((run) => run.kind === "verify" || (run.kind === "stage" && run.stage === "testing"));
	const blocking = [...new Map(runs.filter((run) => run.kind === "flow_step" && run.stage === "feedback" && run.resultStatus).map((run) => [run.id.replace(/^c[^-]+-/, "").replace(/-\d+$/, ""), run])).values()];
	const blockingCount = blocking.filter((run) => run.resultStatus === "fail").length;
	const spend = detail.data ? ` · ${formatTokens(detail.data.runs.reduce((sum, run) => sum + (run.tokens?.total ?? 0), 0))} tok${detail.data.spend.spentUsd ? ` · ${formatMoney(detail.data.spend.spentUsd)}` : ""}` : "";

	const decide = useMutation({
		mutationFn: (decision: "approve" | "reject") =>
			api.decideGate(gate.cardId, gate.id, decision, decision === "reject" ? note.trim() : undefined, decision === "approve" && gate.kind === "feedback"),
		onSuccess: (_card, decision) => {
			void queryClient.invalidateQueries({ queryKey: ["board"] });
			void queryClient.invalidateQueries({ queryKey: ["card", gate.cardId] });
			toast(decision === "approve" ? `Approved “${card?.title ?? gate.cardId}”.` : `Sent back with your note.`);
		},
		onError: (error: Error) => toast(error.message),
	});

	return (
		<li className="rounded-lg border border-rule bg-sheet p-4" data-gate={gate.kind}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate text-[16px] font-semibold">{card?.title ?? gate.cardId}</p>
					<p className="mt-0.5 text-[13px] text-slate">
						<span className="rounded bg-caution-soft px-1.5 py-px font-medium text-caution-text">{KIND[gate.kind]}</span>
						<span className="ml-2">{projectName}</span>
						{spend && <span className="mono">{spend}</span>}
					</p>
				</div>
			</div>
			{detail.data && gate.kind === "feedback" && (
				<p className="mt-2 text-[13.5px] text-slate">
					{blockingCount > 0 ? (
						<>
							<span className="rounded bg-danger-soft px-1.5 py-px font-medium text-danger">{blockingCount} blocking</span> — read the findings before approving
						</>
					) : (
						<span className="rounded bg-ok-soft px-1.5 py-px font-medium text-ok">Clear</span>
					)}
					{checks?.resultSummary && <span className="ml-2">{checks.resultSummary}</span>}
				</p>
			)}
			{detail.data && gate.kind === "plan_approval" && detail.data.card.needsAttentionReason && <p className="mt-2 text-[13.5px] text-slate">{detail.data.card.needsAttentionReason}</p>}
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<button type="button" className="btn primary grow sm:!text-[15px]" disabled={decide.isPending} onClick={() => decide.mutate("approve")}>
					<Icon name="check" />
					{gate.kind === "plan_approval" ? "Approve plan" : gate.kind === "feedback" ? "Approve & land" : "Approve"}
				</button>
				{!sendingBack && (
					<button
						type="button"
						className="btn sm:!text-[15px]"
						onClick={() => {
							setSendingBack(true);
							setNote("");
						}}
					>
						Send back…
					</button>
				)}
				<button type="button" className="btn ghost sm:!text-[15px]" onClick={() => onOpen(gate.cardId)}>
					Open card
				</button>
			</div>
			{sendingBack && (
				<div className="mt-3 rounded-md border border-rule bg-wash p-3">
					<label htmlFor={`note-${gate.id}`} className="text-[13px] font-medium">
						What should change? The note rides back to the agents.
					</label>
					<textarea id={`note-${gate.id}`} value={note} onChange={(event) => setNote(event.target.value)} rows={3} autoFocus className="mt-1.5 w-full rounded border border-rule bg-sheet p-2 text-[14px]" placeholder="The empty-list case is unhandled — see the review finding." />
					<div className="mt-2 flex justify-end gap-2">
						<button type="button" className="btn ghost" onClick={() => setSendingBack(false)}>
							Cancel
						</button>
						<button type="button" className="btn primary" disabled={note.trim() === "" || decide.isPending} onClick={() => decide.mutate("reject")}>
							{decide.isPending ? "Sending…" : "Send back with note"}
						</button>
					</div>
				</div>
			)}
		</li>
	);
}
