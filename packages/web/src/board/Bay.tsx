import type { Card, Project } from "@traffic-control/core";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { Strip, StripButton } from "./Strip.tsx";
import { isLive } from "./status.ts";

interface BayProps {
	project: Project;
	cards: Card[];
	selectedCardId: string | null;
	onOpen: (cardId: string) => void;
}

/** A project, drawn as a strip bay: the rack that holds its cards. */
export function Bay({ project, cards, selectedCardId, onOpen }: BayProps) {
	const [adding, setAdding] = useState(false);
	const start = useMutation({ mutationFn: api.enqueue, onSuccess: (card) => onOpen(card.id) });
	const retry = useMutation({ mutationFn: (cardId: string) => api.retry(cardId), onSuccess: (card) => onOpen(card.id) });
	const abort = useMutation({ mutationFn: api.abort });
	const failure = start.error ?? retry.error ?? abort.error;

	return (
		<section className="@container rounded-md bg-rack p-3">
			<header className="mb-2 flex items-baseline gap-3 px-1">
				<h2 className="text-[17px] font-semibold">{project.name}</h2>
				<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-dust" title={project.repoPath}>
					{project.repoPath} on {project.defaultBranch}
				</span>
				<button type="button" onClick={() => setAdding((open) => !open)} className="cursor-pointer text-[14px] text-chalk underline decoration-seam underline-offset-4 hover:decoration-chalk">
					{adding ? "Cancel" : "Add card"}
				</button>
			</header>

			{adding && <NewCard projectId={project.id} onDone={() => setAdding(false)} />}
			{failure && <p className="mb-2 rounded-[3px] bg-rose px-3 py-1.5 text-[14px] text-ink">{failure.message}</p>}

			{cards.length === 0 && !adding ? (
				<p className="px-1 py-3 text-[14px] text-dust">No cards yet. Add one to describe a piece of work for this project.</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{cards.map((card) => (
						<Strip
							key={card.id}
							card={card}
							selected={card.id === selectedCardId}
							onOpen={() => onOpen(card.id)}
							action={
								isLive(card) ? (
									<StripButton onClick={() => abort.mutate(card.id)} disabled={abort.isPending}>
										Abort
									</StripButton>
								) : card.stage === "backlog" ? (
									<StripButton onClick={() => start.mutate(card.id)} disabled={start.isPending}>
										Start
									</StripButton>
								) : card.status === "awaiting_gate" ? (
									<StripButton onClick={() => onOpen(card.id)}>Review</StripButton>
								) : card.status === "needs_attention" || card.status === "idle" ? (
									<StripButton onClick={() => retry.mutate(card.id)} disabled={retry.isPending}>
										Run again
									</StripButton>
								) : null
							}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function NewCard({ projectId, onDone }: { projectId: string; onDone: () => void }) {
	const [title, setTitle] = useState("");
	const [brief, setBrief] = useState("");
	const add = useMutation({ mutationFn: () => api.addCard(projectId, title, brief), onSuccess: onDone });
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (title.trim()) add.mutate();
	};
	return (
		<form onSubmit={submit} className="mb-2 flex flex-col gap-2 rounded-[3px] bg-buff p-3 text-ink">
			<input
				autoFocus
				value={title}
				onChange={(event) => setTitle(event.target.value)}
				placeholder="What should be done?"
				aria-label="Card title"
				className="border-b border-ink/40 bg-transparent py-1 font-semibold placeholder:font-normal placeholder:text-ink/50 focus:outline-none"
			/>
			<textarea
				value={brief}
				onChange={(event) => setBrief(event.target.value)}
				placeholder="Details the planner should know: constraints, files, what done looks like."
				aria-label="Card details"
				rows={3}
				className="resize-y bg-transparent text-[14px] placeholder:text-ink/50 focus:outline-none"
			/>
			<div className="flex items-center gap-3">
				<StripButton disabled={!title.trim() || add.isPending}>
					Add card
				</StripButton>
				{add.error && <span className="text-[14px]">{add.error.message}</span>}
			</div>
		</form>
	);
}
