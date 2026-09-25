import type { Gate } from "../api/client.ts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.ts";
import { button, field } from "../ui.ts";

/**
 * The budget gate: the card's spend reached the project's per-card ceiling while the work itself was
 * sound. Approving replays the settle exactly where it paused; declining parks the card until the
 * budget is raised or cleared — the decision, and the money, stay the person's.
 */
export function BudgetGatePanel({ cardId, gate }: { cardId: string; gate: Gate }) {
	const [feedback, setFeedback] = useState("");
	const decide = useMutation({ mutationFn: (decision: "approve" | "reject") => api.decideGate(cardId, gate.id, decision, feedback.trim()) });
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<p className="shrink-0 border-b border-rule bg-caution-soft px-4 py-2 text-[14px]">This card has spent its budget. The work so far settled clean — deciding here is about money, not quality.</p>
			<div className="min-h-0 flex-1 overflow-y-auto bg-sheet px-5 py-4">
				{gate.feedback && <p className="font-semibold">{gate.feedback}</p>}
				<p className="mt-2 max-w-[70ch] text-[14px] text-slate">
					Approving continues the card exactly where it paused — same plan, same branch, same gates. Declining parks it until the budget is raised or cleared in the project's settings, then Retry continues from the same spot. Every session's spend so far is on the Usage page.
				</p>
			</div>
			<div className="shrink-0 border-t border-rule bg-sheet p-3">
				<label htmlFor="budget-feedback" className="mb-1 block text-[13px] text-slate">
					Optional note — a decline's note is what the card shows as its reason.
				</label>
				<textarea id="budget-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={2} className={`${field} resize-y`} placeholder="Worth it — this is the risky part" />
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<button type="button" onClick={() => decide.mutate("approve")} disabled={decide.isPending} className={button.primary}>
						Approve and continue
					</button>
					<button type="button" onClick={() => decide.mutate("reject")} disabled={decide.isPending} className={button.quiet}>
						Decline — pause here
					</button>
					{decide.error && <span className="text-[14px] text-danger">{decide.error.message}</span>}
				</div>
			</div>
		</div>
	);
}
