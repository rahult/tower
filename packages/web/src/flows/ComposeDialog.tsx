import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type FlowInfo } from "../api/client.ts";
import { ErrorNote, Modal } from "../app/bits.tsx";
import { toast } from "../app/toasts.tsx";
import { KIND_LABEL, stepKind } from "./graph.ts";
import { FlowGraph } from "./FlowGraph.tsx";

interface ComposeDialogProps {
	/** Composing from the Flows page: pick any card. */
	cards?: Array<{ id: string; title: string; worktreePath: string | null }>;
	/** Composing from a card's Run tab: the task is already picked. */
	pickedCardId?: string;
	onClose: () => void;
	/** The draft was saved (or saved and run): the parent opens the editor or just toasts. */
	onSaved: (flow: FlowInfo) => void;
	onOpenCard?: (cardId: string) => void;
}

/**
 * The composer's confirmation: an agent designed a state machine for a task; the person reads it,
 * then saves it as their own — nothing files itself, exactly like a proposed backlog card.
 */
export function ComposeDialog({ cards, pickedCardId, onClose, onSaved, onOpenCard }: ComposeDialogProps) {
	const [cardId, setCardId] = useState(pickedCardId ?? cards?.[0]?.id ?? "");
	const detail = useQuery({ queryKey: ["card", pickedCardId], queryFn: () => api.card(pickedCardId!), enabled: pickedCardId !== undefined });
	const card = pickedCardId
		? detail.data
			? { id: detail.data.card.id, title: detail.data.card.title, worktreePath: detail.data.card.worktreePath }
			: undefined
		: (cards?.find((candidate) => candidate.id === cardId) ?? undefined);
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<FlowInfo | null>(null);

	const compose = useMutation({
		mutationFn: (id: string) => api.composeFlow(id),
		onSuccess: ({ draft: composed }) => setDraft(composed),
	});
	const save = useMutation({
		mutationFn: async ({ flow, run }: { flow: FlowInfo; run: boolean }) => {
			const saved = await api.saveFlow(flow);
			if (run) await api.adhoc(cardId, { flow: flow.name });
			return saved;
		},
		onSuccess: ({ flow: saved }, { run }) => {
			void queryClient.invalidateQueries({ queryKey: ["flows"] });
			toast(run ? `Saved "${saved.name}" and started it on “${card?.title ?? "the card"}”.` : `Saved "${saved.name}" to your flows.`);
			onSaved(saved);
		},
	});

	const needsWorktree = draft !== null && draft.steps.some((step) => stepKind(step) === "command" || step.access === "write");
	const runnable = card?.worktreePath !== null && card?.worktreePath !== undefined && !(needsWorktree && !card?.worktreePath);

	return (
		<Modal wide title={draft ? `Draft: ${draft.title}` : "Compose a flow from a task"} onClose={onClose}>
			{!draft ? (
				<div className="flow-compose-pick">
					<p className="text-slate">An agent reads the task's brief and plan, then designs the state machine the task should pass through — gates that prove, agent steps that judge. You confirm before anything is saved.</p>
					{!pickedCardId && (
						<label className="flow-field">
							<span>Task</span>
							<select className="input" value={cardId} onChange={(event) => setCardId(event.target.value)} aria-label="Card to compose from">
								{cards?.map((candidate) => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.title}
									</option>
								))}
							</select>
						</label>
					)}
					<div className="flex justify-end gap-2">
						{onOpenCard && card && (
							<button type="button" className="btn" onClick={() => onOpenCard(card.id)}>
								Open the card
							</button>
						)}
						<button type="button" className="btn primary" onClick={() => compose.mutate(cardId)} disabled={!cardId || compose.isPending}>
							{compose.isPending ? "Designing…" : "Design the flow"}
						</button>
					</div>
					<ErrorNote error={compose.error} onRetry={() => compose.reset()} />
				</div>
			) : (
				<div className="flow-compose-draft">
					<p className="text-slate">{draft.description}</p>
					<div className="flow-compose-graph">
						<FlowGraph flow={draft} />
					</div>
					<ul className="flow-compose-steps">
						{draft.steps.map((step, index) => (
							<li key={step.name}>
								<span className={`glyph ${stepKind(step)}`}>{stepKind(step) === "command" ? ">_" : "✦"}</span>
								<strong>{step.name}</strong>
								<span className="text-slate">
									{KIND_LABEL[stepKind(step)]}
									{index === 0 ? " · starts the walk" : ""}
								</span>
							</li>
						))}
					</ul>
					<ErrorNote error={save.error} onRetry={() => save.reset()} />
					<div className="flex justify-end gap-2">
						<button type="button" className="btn" onClick={() => setDraft(null)}>
							Back
						</button>
						<button type="button" className="btn" onClick={() => save.mutate({ flow: draft, run: false })} disabled={save.isPending}>
							Save to my flows
						</button>
						<button
							type="button"
							className="btn primary"
							onClick={() => save.mutate({ flow: draft, run: true })}
							disabled={save.isPending || !runnable}
							title={card?.worktreePath ? undefined : "This card has not started. A flow that runs commands or writes code needs its worktree — save it and run it once the card starts; read-only flows can run now."}
						>
							Save &amp; run on this card
						</button>
					</div>
				</div>
			)}
		</Modal>
	);
}
