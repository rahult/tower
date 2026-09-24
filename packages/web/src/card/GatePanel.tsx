import type { Annotation } from "@tower/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Gate } from "../api/client.ts";
import { Markdown } from "../content/Markdown.tsx";
import { Annotatable } from "./Annotations.tsx";
import { button, field } from "../ui.ts";

/**
 * The plan-approval decision: read the plan, annotate it, then approve it or send it back. Selecting
 * text pins a margin note; a rejection can be notes alone — they are the what-should-change.
 */
export function GatePanel({ cardId, gate, annotations }: { cardId: string; gate: Gate; annotations: Annotation[] }) {
	const [feedback, setFeedback] = useState("");
	const plan = useQuery({ queryKey: ["artifact", cardId, "plan.md", gate.id], queryFn: () => api.artifact(cardId, "plan.md") });
	const decide = useMutation({ mutationFn: (decision: "approve" | "reject") => api.decideGate(cardId, gate.id, decision, feedback.trim()) });
	const openNotes = annotations.filter((annotation) => !annotation.resolved).length;
	const canReject = feedback.trim() !== "" || openNotes > 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<p className="shrink-0 border-b border-rule bg-caution-soft px-4 py-2 text-[14px]">The planner is done. A cheaper model will build from this plan alone, so it has to stand on its own. Select any text to pin a note to it.</p>
			<div className="min-h-0 flex-1 overflow-y-auto bg-sheet px-5 py-4">
				{plan.isPending ? (
					<p className="text-slate">Loading the plan…</p>
				) : plan.error ? (
					<p className="text-danger">Cannot load plan.md: {plan.error.message}</p>
				) : (
					<Annotatable cardId={cardId} artifact="plan.md" annotations={annotations} contentKey={plan.data?.length}>
						<Markdown text={plan.data} />
					</Annotatable>
				)}
			</div>
			<div className="shrink-0 border-t border-rule bg-sheet p-3">
				<label htmlFor="gate-feedback" className="mb-1 block text-[13px] text-slate">
					To send it back, say what should change. The planner starts over with your note
					{openNotes > 0 ? " — and your margin notes ride along." : "."}
				</label>
				<textarea
					id="gate-feedback"
					value={feedback}
					onChange={(event) => setFeedback(event.target.value)}
					rows={2}
					className={`${field} resize-y`}
					placeholder="Keep the public API unchanged; add the new behaviour behind an option"
				/>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<button type="button" onClick={() => decide.mutate("approve")} disabled={decide.isPending} className={button.primary}>
						Approve plan and build
					</button>
					<button type="button" onClick={() => decide.mutate("reject")} disabled={decide.isPending || !canReject} className={button.quiet}>
						Send back to planner
					</button>
					{openNotes > 0 && (
						<span className="text-[13px] text-caution-text">
							{openNotes} open {openNotes === 1 ? "note" : "notes"} — pinned to the plan and sent with a rejection until you resolve them.
						</span>
					)}
					{decide.error && <span className="text-[14px] text-danger">{decide.error.message}</span>}
				</div>
			</div>
		</div>
	);
}
