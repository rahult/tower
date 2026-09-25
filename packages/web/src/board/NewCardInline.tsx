import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { field } from "../ui.ts";

/** The add-card form that opens inside a board lane's Backlog cell. An open card with a branch can be
 *  chosen to stack on: the new card's work then starts from that branch instead of the default one. */
export function NewCardInline({ projectId, onDone }: { projectId: string; onDone: () => void }) {
	const [title, setTitle] = useState("");
	const [brief, setBrief] = useState("");
	const [baseCardId, setBaseCardId] = useState("");
	const board = useQuery({ queryKey: ["board"], queryFn: api.board });
	const stackable = (board.data?.cards ?? []).filter((card) => card.projectId === projectId && card.branchName && card.stage !== "done" && card.stage !== "backlog");
	const add = useMutation({ mutationFn: () => api.addCard(projectId, title, brief, baseCardId || undefined), onSuccess: onDone });
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (title.trim()) add.mutate();
	};
		return (
			<form
				onSubmit={submit}
				onKeyDown={(event) => {
					// Escape belongs to this form first, so one press does not also close the docked inspector.
					if (event.key === "Escape") {
						event.stopPropagation();
						onDone();
					}
				}}
				className="mb-1.5 flex flex-col gap-2 rounded-md border border-primary bg-sheet p-2.5"
			>
				<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What should be done?" aria-label="Card title" className={`${field} font-semibold placeholder:font-normal`} />
				<textarea
					value={brief}
					onChange={(event) => setBrief(event.target.value)}
					placeholder="What the planner should know: constraints, files, what done looks like."
					aria-label="Card details"
					rows={4}
					className={`${field} resize-y text-[14px]`}
				/>
				{stackable.length > 0 && (
					<select aria-label="Stack on card (optional)" value={baseCardId} onChange={(event) => setBaseCardId(event.target.value)} className={`${field} text-[14px]`}>
						<option value="">Branch from main</option>
						{stackable.map((card) => (
							<option key={card.id} value={card.id}>
								Stack on {card.title.slice(0, 60)} ({card.id})
							</option>
						))}
					</select>
				)}
				<div className="flex items-center gap-3">
					<button type="submit" disabled={!title.trim() || add.isPending} className="btn primary sm">
						Add card
					</button>
					<button type="button" onClick={onDone} className="btn ghost sm">
						Cancel
					</button>
					{add.error && <span className="text-[13px] text-danger">{add.error.message}</span>}
				</div>
			</form>
		);
}
