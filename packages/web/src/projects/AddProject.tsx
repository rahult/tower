import type { Project } from "@tower/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type DirListing, api } from "../api/client.ts";
import { Modal } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { toast } from "../app/toasts.tsx";
import { monoField } from "../ui.ts";

/**
 * Add a project on its own, separate from adding work. Instead of typing a path, the picker walks the
 * daemon's filesystem: the list starts at the home directory, a click descends, git repositories are
 * flagged, and the shown directory is what "Add project" adds.
 */
export function AddProject({ onAdded, onClose }: { onAdded: (project: Project) => void; onClose: () => void }) {
	const queryClient = useQueryClient();
	const [path, setPath] = useState("");
	const [listing, setListing] = useState<DirListing | null>(null);
	const [browseError, setBrowseError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	// The daemon resolves "~", relative paths and symlinks, so every shown directory is canonical.
	const browse = async (next: string) => {
		setLoading(true);
		setBrowseError(null);
		try {
			const listing = await api.dirList(next.trim() || undefined);
			setListing(listing);
			setPath(listing.path);
		} catch (error) {
			setBrowseError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	};
	useEffect(() => {
		void browse("");
	}, []);

	const add = useMutation({
		mutationFn: () => api.addProject(path.trim()),
		onSuccess: (project) => {
			void queryClient.invalidateQueries({ queryKey: ["board"] });
			toast(`Added ${project.name}. Tell it what to do next.`);
			onAdded(project);
		},
	});

	return (
		<Modal title="Add project" onClose={onClose}>
			<p className="meta">
				Pick the git repository directory on this machine. Tower gives every card its own worktree inside it — your checkout is never touched.
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (!add.isPending) add.mutate();
				}}
				className="grid gap-4"
			>
				<div className="field">
					<label htmlFor="project-path">Directory</label>
					<input
						id="project-path"
						value={path}
						onChange={(event) => setPath(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void browse(path);
							}
						}}
						spellCheck={false}
						className={monoField}
						placeholder="/Users/you/code/my-project"
					/>
					<span className="hint">Edit and press Enter to jump anywhere, including directories the listing skips.</span>
				</div>

				<div className="field">
					<div
						role="listbox"
						aria-label="Directories"
						className="max-h-56 overflow-y-auto overscroll-contain rounded-md border border-rule bg-wash"
					>
						{listing && listing.parent !== listing.path && (
							<button type="button" role="option" aria-selected="false" onClick={() => void browse(listing.parent)} className="flex w-full cursor-pointer items-center gap-2 border-b border-rule px-3 py-2 text-left text-[14px] text-slate hover:bg-wash">
								<Icon name="back" className="icon" />
								<span className="font-mono text-[13px]">{listing.parent}</span>
							</button>
						)}
						{listing?.dirs.map((dir) => (
							<button
								key={dir.path}
								type="button"
								role="option"
								aria-selected={path === dir.path}
								onClick={() => void browse(dir.path)}
								onDoubleClick={() => setPath(dir.path)}
								className={`flex w-full cursor-pointer items-center gap-2 border-b border-rule px-3 py-2 text-left text-[14px] last:border-b-0 hover:bg-wash ${path === dir.path ? "bg-primary-soft" : ""}`}
							>
								<Icon name="folder" className="icon" />
								<span className="min-w-0 flex-1 truncate font-mono text-[13px]">{dir.name}</span>
								{dir.git && <span className="chip mono">git repo</span>}
							</button>
						))}
						{loading && <p className="px-3 py-3 text-[14px] text-slate">Listing…</p>}
						{!loading && listing && listing.dirs.length === 0 && <p className="px-3 py-3 text-[14px] text-slate">No subdirectories here.</p>}
					</div>
					{browseError && <span className="error">{browseError}</span>}
					<span className="hint">Hidden folders are skipped; type their path above to reach one.</span>
				</div>

				<div className="acts !justify-between">
					<button type="button" onClick={onClose} className="btn ghost">
						Cancel
					</button>
					<button type="submit" disabled={add.isPending || !path.trim()} className="btn primary">
						{add.isPending ? "Adding…" : "Add project"}
					</button>
				</div>
				{add.error && <p className="!mt-0 text-[14px] text-danger">{add.error.message}</p>}
			</form>
		</Modal>
	);
}
