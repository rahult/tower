import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Gate } from "../api/client.ts";

/** The plan-approval decision: read the plan, then approve it or send it back with what should change. */
export function GatePanel({ cardId, gate }: { cardId: string; gate: Gate }) {
	const [feedback, setFeedback] = useState("");
	const plan = useQuery({ queryKey: ["artifact", cardId, "plan.md", gate.id], queryFn: () => api.artifact(cardId, "plan.md") });
	const decide = useMutation({ mutationFn: (decision: "approve" | "reject") => api.decideGate(cardId, gate.id, decision, feedback.trim()) });

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<p className="px-4 pt-3 text-[14px]">The planner is done. A cheaper model will build from this plan alone, so it needs to stand on its own.</p>
			<pre className="mx-4 my-3 flex-1 overflow-auto rounded-[3px] bg-buff p-4 font-sans text-[14px] leading-relaxed whitespace-pre-wrap text-ink">
				{plan.isPending ? "Loading the plan…" : plan.error ? `Cannot load plan.md: ${plan.error.message}` : plan.data}
			</pre>
			<div className="border-t border-seam p-3">
				<label htmlFor="gate-feedback" className="mb-1 block text-[13px] text-dust">
					To send it back, say what should change. The planner starts over with your note.
				</label>
				<textarea
					id="gate-feedback"
					value={feedback}
					onChange={(event) => setFeedback(event.target.value)}
					rows={2}
					className="w-full resize-y rounded-[3px] bg-buff px-3 py-2 text-ink placeholder:text-ink/50"
					placeholder="Keep the public API unchanged; add the new behaviour behind an option"
				/>
				<div className="mt-2 flex items-center gap-2">
					<button type="button" onClick={() => decide.mutate("approve")} disabled={decide.isPending} className="condensed cursor-pointer rounded-[3px] bg-sage px-3 py-2 font-semibold text-ink hover:brightness-105 disabled:opacity-40">
						Approve plan and build
					</button>
					<button
						type="button"
						onClick={() => decide.mutate("reject")}
						disabled={decide.isPending || !feedback.trim()}
						className="condensed cursor-pointer rounded-[3px] border border-chalk/60 px-3 py-2 font-semibold hover:bg-well disabled:cursor-default disabled:opacity-40"
					>
						Send back to planner
					</button>
					{decide.error && <span className="text-[14px] text-rose">{decide.error.message}</span>}
				</div>
			</div>
		</div>
	);
}
