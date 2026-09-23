import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import type { Project } from "@tower/core";
import { api } from "../api/client.ts";
import { field, monoField } from "../ui.ts";
import { Modal } from "./bits.tsx";

/**
 * The one place work enters Tower: pick (or add) a project, say what is wanted, then add it to the
 * backlog or start it straight away. Everything else on the board follows from this.
 */
export function QuickAdd({ projects, presetProjectId, onClose, onOpenCard }: { projects: Project[]; presetProjectId?: string; onClose: () => void; onOpenCard: (cardId: string) => void }) {
	const queryClient = useQueryClient();
	const [projectId, setProjectId] = useState(presetProjectId && projects.some((p) => p.id === presetProjectId) ? presetProjectId : (projects[0]?.id ?? ""));
	const [newRepo, setNewRepo] = useState(projects.length === 0);
	const [repoPath, setRepoPath] = useState("");
	const [title, setTitle] = useState("");
	const [brief, setBrief] = useState("");

	const refresh = () => void queryClient.invalidateQueries({ queryKey: ["board"] });
	const addProject = useMutation({ mutationFn: () => api.addProject(repoPath.trim()) });

	// One chain, whichever button sent it: maybe create the project, create the card, maybe start it.
	const finish = useMutation({
		mutationFn: async ({ start }: { start: boolean }) => {
			const project = newRepo ? await addProject.mutateAsync() : (projects.find((p) => p.id === projectId) as Project);
			const card = await api.addCard(project.id, title.trim(), brief.trim());
			if (start) await api.enqueue(card.id);
			return card;
		},
		onSuccess: (card) => {
			refresh();
			onClose();
			onOpenCard(card.id);
		},
	});

	const ready = title.trim() !== "" && (newRepo ? repoPath.trim() !== "" : projectId !== "");
	const run = (start: boolean) => {
		if (ready && !busy) finish.mutate({ start });
	};
	const busy = finish.isPending || addProject.isPending;
	const failure = finish.error ?? addProject.error;
	const [start, setStart] = useState<"now" | "backlog">("now");

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
				{projects.length > 0 && (
					<div className="field">
						<label htmlFor="quick-project">Project</label>
						<select id="quick-project" value={newRepo ? "" : projectId} onChange={(event) => setProjectId(event.target.value)} className={field} disabled={projects.length === 0}>
							{projects.map((project) => (
								<option key={project.id} value={project.id}>
									{project.name} · {project.defaultBranch}
								</option>
							))}
						</select>
						<label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate">
							<input type="checkbox" className="size-4 accent-[var(--primary)]" checked={newRepo} onChange={(event) => setNewRepo(event.target.checked)} />
							New repository — add it by path
						</label>
					</div>
				)}
				{(newRepo || projects.length === 0) && (
					<div className="field">
						<label htmlFor="quick-repo">Repository path</label>
						<span className="hint">A git repository on this machine. A brand-new one is fine.</span>
						<input id="quick-repo" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} spellCheck={false} placeholder="/Users/you/code/my-project" className={monoField} />
					</div>
				)}
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
}

/** The empty-board invitation: the same chain, reduced to a repository path. */
export function NewProjectForm({ first }: { first?: boolean }) {
	const queryClient = useQueryClient();
	const [repoPath, setRepoPath] = useState("");
	const add = useMutation({
		mutationFn: () => api.addProject(repoPath.trim()),
		onSuccess: () => {
			setRepoPath("");
			void queryClient.invalidateQueries({ queryKey: ["board"] });
		},
	});
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (repoPath.trim()) add.mutate();
	};
	return (
		<form onSubmit={submit} className="max-w-[44rem] rounded-lg border border-dashed border-rule p-3">
			<label htmlFor="repo-path" className="mb-1.5 block font-semibold">
				{first ? "Add your first project" : "Add a project"}
				<span className="block text-[13px] font-normal text-slate">The path to a git repository on this machine. A brand-new one is fine.</span>
			</label>
			<div className="flex gap-2">
				<input id="repo-path" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/Users/you/code/my-project" className={monoField} />
				<button type="submit" disabled={!repoPath.trim() || add.isPending} className="btn primary whitespace-nowrap">
					Add project
				</button>
			</div>
			{add.error && <p className="mt-1.5 text-[14px] text-danger">{add.error.message}</p>}
		</form>
	);
}
