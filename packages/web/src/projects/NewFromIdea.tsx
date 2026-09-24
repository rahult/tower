import type { Card, Project } from "@tower/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { Modal } from "../app/bits.tsx";
import { toast } from "../app/toasts.tsx";
import { field } from "../ui.ts";

/**
 * A project born from an idea: name it, describe it, pick the archetype — Tower scaffolds the
 * engineering baseline, files the idea as the first card, and planning starts. The person's job is
 * the idea and the plan gate; the practices live in the archetype and the harness.
 */
export function NewFromIdea({ onCreated, onClose }: { onCreated: (project: Project, card: Card) => void; onClose: () => void }) {
	const queryClient = useQueryClient();
	const archetypes = useQuery({ queryKey: ["archetypes"], queryFn: api.archetypes });
	const [name, setName] = useState("");
	const [idea, setIdea] = useState("");
	const [archetype, setArchetype] = useState("web-app");

	useEffect(() => {
		if (archetypes.data && !archetypes.data.archetypes.some((candidate) => candidate.name === archetype)) {
			setArchetype(archetypes.data.archetypes[0]?.name ?? "web-app");
		}
	}, [archetypes.data, archetype]);

	const create = useMutation({
		mutationFn: () => api.fromIdea({ name: name.trim(), idea: idea.trim(), archetype }),
		onSuccess: ({ project, card }) => {
			void queryClient.invalidateQueries({ queryKey: ["board"] });
			toast(`Scaffolded ${project.name} — planning the idea now.`);
			onCreated(project, card);
		},
	});

	return (
		<Modal title="New from idea" onClose={onClose}>
			<p className="meta">
				The archetype is the engineering baseline — layout, toolchain, tests, acceptance harness. Your idea becomes the first card: an agent models it into a plan, you approve the plan, and the build is gated test-first.
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (!create.isPending) create.mutate();
				}}
				className="grid gap-4"
			>
				<div className="field">
					<label htmlFor="idea-name">Name</label>
					<input id="idea-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Todo app" spellCheck={false} autoFocus />
				</div>
				<div className="field">
					<label htmlFor="idea-text">The idea</label>
					<textarea
						id="idea-text"
						value={idea}
						onChange={(event) => setIdea(event.target.value)}
						placeholder="A todo app — quick capture, due today front and centre, repeats, works offline. Two people can share a list."
						rows={5}
					/>
					<span className="hint">Describe what it should do and for whom; the planner will ask about anything that would change the plan.</span>
				</div>
				<div className="field">
					<label htmlFor="idea-archetype">Archetype</label>
					<select id="idea-archetype" value={archetype} onChange={(event) => setArchetype(event.target.value)} className={field}>
						{(archetypes.data?.archetypes ?? [{ name: "web-app", title: "Web app", description: "" }]).map((candidate) => (
							<option key={candidate.name} value={candidate.name}>
								{candidate.title}
							</option>
						))}
					</select>
					<span className="hint">{archetypes.data?.archetypes.find((candidate) => candidate.name === archetype)?.description}</span>
				</div>
				<div className="acts !justify-between">
					<button type="button" onClick={onClose} className="btn ghost">
						Cancel
					</button>
					<button type="submit" disabled={create.isPending || !name.trim() || !idea.trim()} className="btn primary">
						{create.isPending ? "Scaffolding…" : "Scaffold and plan"}
					</button>
				</div>
				{create.error && <p className="!mt-0 text-[14px] text-danger">{create.error.message}</p>}
			</form>
		</Modal>
	);
}
