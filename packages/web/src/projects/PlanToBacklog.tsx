import type { Card, Project } from "@tower/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type PlanCard } from "../api/client.ts";
import { Modal } from "../app/bits.tsx";
import { toast } from "../app/toasts.tsx";
import { button, field } from "../ui.ts";

/**
 * Plan to backlog: hand Tower a plan — pasted, or a card's own plan.md — and the work-breakdown
 * agent drafts the backlog cards it cuts into. The draft comes back unchecked-by-default-nothing:
 * every card is proposed, the reader unticks what they don't want, and filing lands them as inert
 * backlog cards in the plan's order — a queue waiting for the night.
 */
export function PlanToBacklog({ project, cards, onClose, onFiled }: { project: Project; cards: Card[]; onClose: () => void; onFiled: (filed: number) => void }) {
	const queryClient = useQueryClient();
	const [mode, setMode] = useState<"input" | "preview">("input");
	const [planText, setPlanText] = useState("");
	const [cardId, setCardId] = useState("");
	const [picked, setPicked] = useState<PlanCard[]>([]);
	const [checked, setChecked] = useState<boolean[]>([]);

	const draft = useMutation({
		mutationFn: () => api.planToBacklog(project.id, planText.trim() ? { plan: planText } : { cardId }),
		onSuccess: ({ cards: proposed }) => {
			if (proposed.length === 0) {
				toast("The agent proposed no cards — try a more concrete plan.");
				return;
			}
			setPicked(proposed);
			setChecked(proposed.map(() => true));
			setMode("preview");
		},
	});

	const file = useMutation({
		mutationFn: (queue: boolean) => api.filePlanCards(project.id, picked.filter((_, index) => checked[index]), queue),
		onSuccess: ({ cards: filed }) => {
			void queryClient.invalidateQueries({ queryKey: ["board"] });
			toast(`Filed ${filed.length} ${filed.length === 1 ? "card" : "cards"} to ${project.name}'s backlog.`);
			onFiled(filed.length);
		},
	});

	const pickedCount = checked.filter(Boolean).length;

	return (
		<Modal title={`Plan to backlog — ${project.name}`} onClose={onClose}>
			{mode === "input" ? (
				<>
					<p className="meta">
						Paste a plan — a feature outline, a spec, a roadmap section — and the agent cuts it into backlog cards Tower can plan, build and verify one at a time. You approve the draft before anything is filed.
					</p>
					<div className="grid gap-4">
						<div className="field">
							<label htmlFor="plan-text">The plan</label>
							<textarea
								id="plan-text"
								value={planText}
								onChange={(event) => setPlanText(event.target.value)}
								rows={10}
								placeholder={"1. Accounts — sign up, sign in, sign out; sessions in a cookie.\n2. Lists — create, rename, delete; one owner, invited members later.\n3. Todos — the CRUD, ordering within a list, and a due date.\n…"}
							/>
						</div>
						<div className="field">
							<label htmlFor="plan-card">…or cut an existing card's plan</label>
							<select id="plan-card" value={cardId} onChange={(event) => setCardId(event.target.value)} className={field}>
								<option value="">— none, use the pasted plan —</option>
								{cards.filter((card) => card.stage !== "backlog" && card.stage !== "done").map((card) => (
									<option key={card.id} value={card.id}>
										{card.title}
									</option>
								))}
							</select>
							<span className="hint">{cardId ? "That card's plan.md is the plan; the pasted text is ignored." : "Optional — for when a card's plan turned out bigger than one card."}</span>
						</div>
						<div className="acts !justify-between">
							<button type="button" onClick={onClose} className="btn ghost">
								Cancel
							</button>
							<button type="button" className="btn primary" disabled={draft.isPending || (!planText.trim() && !cardId)} onClick={() => draft.mutate()}>
								{draft.isPending ? "Reading the plan…" : "Draft the cards"}
							</button>
						</div>
						{draft.error && <p className="!mt-0 text-[14px] text-danger">{draft.error.message}</p>}
					</div>
				</>
			) : (
				<div className="grid gap-4">
					<p className="meta">
						The agent cut this plan into {picked.length} {picked.length === 1 ? "card" : "cards"}. Untick anything you don't want; the survivors file to the backlog in this order.
					</p>
					<div className="max-h-80 overflow-y-auto rounded-md border border-rule bg-wash p-2">
						<ul className="grid gap-2">
							{picked.map((card, index) => (
								<li key={index}>
									<label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-[14px] hover:bg-sheet">
										<input type="checkbox" className="mt-1 size-4 accent-[var(--primary)]" checked={checked[index] ?? false} onChange={(event) => setChecked((current) => current.map((value, at) => (at === index ? event.target.checked : value)))} />
										<span className="min-w-0">
											<span className="block font-semibold">{card.title}</span>
											<span className="line-clamp-3 block text-[13px] text-slate">{card.brief}</span>
										</span>
									</label>
								</li>
							))}
						</ul>
					</div>
					<div className="acts !justify-between">
						<button type="button" className="btn ghost" onClick={() => setMode("input")}>
							Back
						</button>
						<span className="flex items-center gap-2">
							<button
								type="button"
								className="btn"
								disabled={file.isPending || pickedCount === 0}
								title="File them and enqueue each, so the pipeline plans, builds and reviews the queue on its own — gates still stop for you"
								onClick={() => file.mutate(true)}
							>
								{file.isPending ? "Filing…" : "File and queue"}
							</button>
							<button type="button" className="btn primary" disabled={file.isPending || pickedCount === 0} onClick={() => file.mutate(false)}>
								{file.isPending ? "Filing…" : `File ${pickedCount} ${pickedCount === 1 ? "card" : "cards"} to the backlog`}
							</button>
						</span>
					</div>
					{file.error && <p className="!mt-0 text-[14px] text-danger">{file.error.message}</p>}
				</div>
			)}
		</Modal>
	);
}
