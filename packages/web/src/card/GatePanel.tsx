import type { Annotation } from "@tower/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Gate } from "../api/client.ts";
import { Markdown } from "../content/Markdown.tsx";
import { Annotatable } from "./Annotations.tsx";
import { button, field } from "../ui.ts";

/**
 * The plan-approval decision: read the plan, annotate it, then approve it or send it back. Selecting
 * text pins a margin note; a rejection can be notes alone — they are the what-should-change. The
 * plan coach is a rubric pass a person can run beside the decision: what the plan leaves unanswered,
 * as advice to pin or ignore — never a verdict.
 */
export function GatePanel({ cardId, gate, annotations }: { cardId: string; gate: Gate; annotations: Annotation[] }) {
	const [feedback, setFeedback] = useState("");
	const plan = useQuery({ queryKey: ["artifact", cardId, "plan.md", gate.id], queryFn: () => api.artifact(cardId, "plan.md") });
	const decide = useMutation({ mutationFn: (decision: "approve" | "reject") => api.decideGate(cardId, gate.id, decision, feedback.trim()) });
	const openNotes = annotations.filter((annotation) => !annotation.resolved).length;
	const canReject = feedback.trim() !== "" || openNotes > 0;

	const coach = useMutation({ mutationFn: () => api.adhoc(cardId, { flow: "plan-coach" }) });
	// The coach report lands as an artifact when its run settles; poll until it exists.
	const report = useQuery({
		queryKey: ["artifact", cardId, "reviews/plan-coach.md", gate.id],
		queryFn: () => api.artifact(cardId, "reviews/plan-coach.md"),
		retry: false,
		refetchInterval: (query) => (query.state.data === undefined && (coach.isSuccess || query.state.error) ? 3000 : false),
	});

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<p className="shrink-0 border-b border-rule bg-caution-soft px-4 py-2 text-[14px]">The planner is done. A cheaper model will build from this plan alone, so it has to stand on its own. Select any text to pin a note to it.</p>
			<div className="flex shrink-0 items-center gap-2 border-b border-rule bg-sheet px-4 py-2">
				<button type="button" onClick={() => coach.mutate()} disabled={coach.isPending} className={button.quiet}>
					{coach.isPending ? "Starting the coach…" : report.data ? "Coach the plan again" : "Coach the plan"}
				</button>
				<span className="text-[13px] text-slate">
					{report.isPending && report.fetchStatus === "fetching" && !report.data
						? "A rubric pass is reading the plan — its advice lands here when it settles."
						: "A rubric pass over the draft: what it leaves unanswered, as advice you can pin or ignore. It never approves or rejects for you."}
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto bg-sheet px-5 py-4">
				{report.data && (
					<section aria-label="Plan coach report" className="mb-5 rounded-lg border border-rule bg-wash/50 p-4">
						<h3 className="mb-2 font-semibold">What the plan doesn't answer</h3>
						<Annotatable cardId={cardId} artifact="reviews/plan-coach.md" annotations={annotations} contentKey={report.data.length}>
							<Markdown text={report.data} />
						</Annotatable>
					</section>
				)}
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
