import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { field } from "../ui.ts";

/** The add-card form that opens inside a board lane's Backlog cell. */
export function NewCardInline({ projectId, onDone }: { projectId: string; onDone: () => void }) {
	const [title, setTitle] = useState("");
	const [brief, setBrief] = useState("");
	const add = useMutation({ mutationFn: () => api.addCard(projectId, title, brief), onSuccess: onDone });
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (title.trim()) add.mutate();
	};
	return (
		<form onSubmit={submit} className="mb-1.5 flex flex-col gap-2 rounded-md border border-primary bg-sheet p-2.5">
			<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What should be done?" aria-label="Card title" className={`${field} font-semibold placeholder:font-normal`} />
			<textarea
				value={brief}
				onChange={(event) => setBrief(event.target.value)}
				placeholder="What the planner should know: constraints, files, what done looks like."
				aria-label="Card details"
				rows={4}
				className={`${field} resize-y text-[14px]`}
			/>
			<div className="flex items-center gap-3">
				<button type="submit" disabled={!title.trim() || add.isPending} className="btn primary sm">
					Add card
				</button>
				{add.error && <span className="text-[13px] text-danger">{add.error.message}</span>}
			</div>
		</form>
	);
}
