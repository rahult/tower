import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import type { Card, Project } from "@tower/core";
import { api } from "../api/client.ts";
import { field } from "../ui.ts";
import { Modal } from "./bits.tsx";

/**
 * Adding work: pick one of the projects Tower already knows, say what is wanted, then add it to the
 * backlog or start it straight away. Adding a *project* is its own dialog — `onAddProject` swaps to it
 * when there is nothing to add work to yet. A card may also wait for another card to land first.
 */
export function QuickAdd({ projects, cards, presetProjectId, onClose, onOpenCard, onAddProject }: {
	projects: Project[];
	cards: Card[];
	presetProjectId?: string;
	onClose: () => void;
	onOpenCard: (cardId: string) => void;
	onAddProject: () => void;
}) {
	const queryClient = useQueryClient();
	const [projectId, setProjectId] = useState(presetProjectId ?? projects[0]?.id ?? "");
	const [title, setTitle] = useState("");
	const [brief, setBrief] = useState("");
	const [dependsOn, setDependsOn] = useState("");

	const refresh = () => void queryClient.invalidateQueries({ queryKey: ["board"] });
	// Only this project's unlanded cards can be waited on, and the list follows the project picker.
	const waitable = cards.filter((card) => card.projectId === projectId && card.stage !== "done");

	// One chain, whichever entry made it: create the card, maybe start it straight away.
	const finish = useMutation({
		mutationFn: async ({ start }: { start: boolean }) => {
			const project = projects.find((p) => p.id === projectId) as Project;
			const card = await api.addCard(project.id, title.trim(), brief.trim(), undefined, dependsOn || undefined);
			if (start) await api.enqueue(card.id);
			return card;
		},
		onSuccess: (card) => {
			refresh();
			onClose();
			onOpenCard(card.id);
		},
	});

	const ready = title.trim() !== "" && projectId !== "";
	const busy = finish.isPending;
	const failure = finish.error;
	const [start, setStart] = useState<"now" | "backlog">("now");

	if (projects.length === 0) {
		return (
			<Modal title="Add work" onClose={onClose}>
				<p className="meta">Tower has no projects yet. A project is a git repository on this machine — add one first, then cards for it.</p>
				<div className="acts !justify-start">
					<button type="button" onClick={onClose} className="btn ghost">
						Cancel
					</button>
					<button
						type="button"
						className="btn primary"
						onClick={() => {
							onClose();
							onAddProject();
						}}
					>
						Add a project
					</button>
				</div>
			</Modal>
		);
	}

	return (
		<Modal title="Add work" onClose={onClose}>
			<p className="meta">
				A card gets its own worktree and branch. An expensive model plans; you approve; a cheap model builds; your tests judge.
			</p>
			<form
				onSubmit={(event: FormEvent) => {
					event.preventDefault();
					run(start === "now");
				}}
				className="grid gap-4"
			>
				<div className="field">
					<label htmlFor="quick-project">Project</label>
					<select id="quick-project" value={projectId} onChange={(event) => setProjectId(event.target.value)} className={field}>
						{projects.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name} · {project.defaultBranch}
							</option>
						))}
					</select>
					<span className="hint">Missing one? Add it from the Projects view or the command box.</span>
				</div>
				<div className="field">
					<label htmlFor="quick-title" className="req">
						What should change
					</label>
					<input
						id="quick-title"
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						autoFocus
						placeholder="Add retry with backoff to the HTTP client"
						aria-invalid={finish.isError && !title.trim() ? true : undefined}
						className={field}
					/>
				</div>
				<div className="field">
					<label htmlFor="quick-brief">Anything the planner should know?</label>
					<span className="hint">Optional. Constraints, files, what done looks like.</span>
					<textarea id="quick-brief" value={brief} onChange={(event) => setBrief(event.target.value)} rows={3} className={`${field} !min-h-0 resize-y`} />
				</div>
				<div className="field">
					<label htmlFor="quick-after">Wait for another card?</label>
					<select id="quick-after" value={dependsOn} onChange={(event) => setDependsOn(event.target.value)} className={field}>
						<option value="">— no, schedule it freely —</option>
						{waitable.map((card) => (
							<option key={card.id} value={card.id}>
								{card.title}
							</option>
						))}
					</select>
					<span className="hint">{dependsOn ? "This card keeps its place in the queue until that card lands." : "Optional — for work that only makes sense once other work has landed."}</span>
				</div>
				<div className="field">
					<label>Start</label>
					<div className="seg" role="group" aria-label="Start">
						<button type="button" aria-pressed={start === "now"} onClick={() => setStart("now")}>
							Plan now
						</button>
						<button type="button" aria-pressed={start === "backlog"} onClick={() => setStart("backlog")}>
							Backlog
						</button>
					</div>
					<span className="hint">Plan now begins when a slot is free. Backlog waits for you to press Start.</span>
				</div>
				<div className="acts !justify-between">
					<button type="button" onClick={onClose} className="btn ghost">
						Cancel
					</button>
					<button type="submit" disabled={!ready || busy} className="btn primary">
						{start === "now" ? "Add and start" : "Add card"}
					</button>
				</div>
				{failure && <p className="!mt-0 text-[14px] text-danger">{failure.message}</p>}
			</form>
		</Modal>
	);

	function run(startMode: boolean) {
		if (ready && !busy) finish.mutate({ start: startMode });
	}
}
