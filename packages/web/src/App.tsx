import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useCallback, useState } from "react";
import { api } from "./api/client.ts";
import { useEventStream } from "./api/stream.ts";
import { Board } from "./board/Board.tsx";
import { Drawer } from "./card/Drawer.tsx";

export function App() {
	const board = useQuery({ queryKey: ["board"], queryFn: api.board });
	const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
	const [openRunId, setOpenRunId] = useState<string | null>(null);
	useEventStream(openRunId);
	const onRunOpen = useCallback((runId: string | null) => setOpenRunId(runId), []);

	const projects = board.data?.projects ?? [];
	const cards = board.data?.cards ?? [];
	const inFlight = cards.filter((card) => card.status === "running" || card.status === "verifying").length;
	const needYou = cards.filter((card) => ["needs_attention", "awaiting_gate", "awaiting_input", "interrupted"].includes(card.status)).length;

	return (
		<div className={`grid h-full ${selectedCardId ? "lg:grid-cols-[minmax(0,1fr)_minmax(28rem,42vw)]" : ""}`}>
			<main className={`min-h-0 overflow-y-auto p-4 ${selectedCardId ? "hidden lg:block" : ""}`}>
				<header className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
					<h1 className="condensed text-[26px] font-bold tracking-tight">Traffic Control</h1>
					{cards.length > 0 && (
						<p className="text-[14px] text-dust">
							{inFlight} running, <span className={needYou > 0 ? "font-semibold text-signal" : ""}>{needYou} need you</span>, {cards.length} cards
						</p>
					)}
				</header>

				{board.error && <p className="mb-3 rounded-[3px] bg-rose px-3 py-2 text-ink">Cannot reach the daemon: {board.error.message}</p>}

				<div className="flex flex-col gap-3">
					{projects.length > 0 && <Board projects={projects} cards={cards} selectedCardId={selectedCardId} onOpen={setSelectedCardId} />}
					<NewProject first={projects.length === 0 && !board.isPending} />
				</div>
			</main>

			{selectedCardId && (
				<div className="min-h-0 border-l border-seam">
					<Drawer key={selectedCardId} cardId={selectedCardId} onClose={() => setSelectedCardId(null)} onRunOpen={onRunOpen} />
				</div>
			)}
		</div>
	);
}

function NewProject({ first }: { first: boolean }) {
	const [repoPath, setRepoPath] = useState("");
	const add = useMutation({ mutationFn: () => api.addProject(repoPath.trim()), onSuccess: () => setRepoPath("") });
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (repoPath.trim()) add.mutate();
	};
	return (
		<form onSubmit={submit} className="max-w-[44rem] rounded-md border border-dashed border-seam p-3">
			<label htmlFor="repo-path" className="mb-1 block text-[14px]">
				{first ? "Add your first project: the path to a git repository on this machine." : "Add a project"}
			</label>
			<div className="flex gap-2">
				<input
					id="repo-path"
					value={repoPath}
					onChange={(event) => setRepoPath(event.target.value)}
					placeholder="/Volumes/Atlas/Code/projects/axiom"
					className="min-w-0 flex-1 rounded-[3px] bg-well px-3 py-1.5 font-mono text-[13px] placeholder:text-dust/60"
				/>
				<button type="submit" disabled={!repoPath.trim() || add.isPending} className="condensed cursor-pointer rounded-[3px] bg-chalk px-3 py-1.5 font-semibold text-ink hover:bg-white disabled:cursor-default disabled:opacity-40">
					Add project
				</button>
			</div>
			{add.error && <p className="mt-1 text-[14px] text-rose">{add.error.message}</p>}
		</form>
	);
}
