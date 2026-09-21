import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import type { Project } from "@tower/core";
import { api } from "../api/client.ts";
import { button, field, monoField } from "../ui.ts";
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

	return (
		<Modal title="Add work" onClose={onClose}>
			<form
				onSubmit={(event: FormEvent) => {
					event.preventDefault();
					run(false);
				}}
				className="flex flex-col gap-4"
			>
				{projects.length > 0 && (
					<div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
						<label htmlFor="quick-project" className="pt-1.5 font-semibold">
							Project
						</label>
						<div className="flex flex-col gap-1.5">
							<select id="quick-project" value={newRepo ? "" : projectId} onChange={(event) => setProjectId(event.target.value)} className={field} disabled={projects.length === 0}>
								{projects.map((project) => (
									<option key={project.id} value={project.id}>
										{project.name}
									</option>
								))}
							</select>
							<label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate">
								<input type="checkbox" className="size-4 accent-[var(--primary)]" checked={newRepo} onChange={(event) => setNewRepo(event.target.checked)} />
								New repository — add it by path
							</label>
						</div>
					</div>
				)}
				{(newRepo || projects.length === 0) && (
					<label className="block font-semibold">
						Repository path
						<span className="block text-[13px] font-normal text-slate">A git repository on this machine. A brand-new one is fine.</span>
						<input value={repoPath} onChange={(event) => setRepoPath(event.target.value)} spellCheck={false} placeholder="/Users/you/code/my-project" className={`mt-1 ${monoField}`} />
					</label>
				)}
				<label className="block font-semibold">
					What should be done?
					<input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus placeholder="Add retry with backoff to the HTTP client" className={`mt-1 ${field}`} />
				</label>
				<label className="block font-semibold">
					Anything the planner should know?
					<span className="block text-[13px] font-normal text-slate">Optional. Constraints, files, what done looks like.</span>
					<textarea value={brief} onChange={(event) => setBrief(event.target.value)} rows={3} className={`mt-1 ${field} resize-y`} />
				</label>
				<div className="flex flex-wrap items-center gap-3">
					<button type="button" onClick={() => run(true)} disabled={!ready || busy} className={button.primary}>
						Add and start
					</button>
					<button type="button" onClick={() => run(false)} disabled={!ready || busy} className={button.quiet}>
						Add to backlog
					</button>
					<span className="text-[13px] text-slate">Starting begins with planning once a slot is free.</span>
				</div>
				{failure && <p className="text-[14px] text-danger">{failure.message}</p>}
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
				<button type="submit" disabled={!repoPath.trim() || add.isPending} className={`${button.primary} whitespace-nowrap`}>
					Add project
				</button>
			</div>
			{add.error && <p className="mt-1.5 text-[14px] text-danger">{add.error.message}</p>}
		</form>
	);
}
