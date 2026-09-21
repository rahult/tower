import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useCallback, useState } from "react";
import { api } from "./api/client.ts";
import { type Connection, useConnection, useEventStream } from "./api/stream.ts";
import { Board } from "./board/Board.tsx";
import { isLive, needsYou } from "./board/status.ts";
import { Drawer } from "./card/Drawer.tsx";
import { ModelSettings } from "./settings/ModelSettings.tsx";
import { useTheme } from "./theme.ts";
import { button, monoField } from "./ui.ts";

export function App() {
	const board = useQuery({ queryKey: ["board"], queryFn: api.board });
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
	const [openRunId, setOpenRunId] = useState<string | null>(null);
	const [showingModels, setShowingModels] = useState(false);
	const [theme, cycleTheme] = useTheme();
	useEventStream(openRunId);
	const connection = useConnection();
	const onRunOpen = useCallback((runId: string | null) => setOpenRunId(runId), []);

	const projects = board.data?.projects ?? [];
	const cards = board.data?.cards ?? [];
	const running = cards.filter(isLive).length;
	const waiting = cards.filter(needsYou).length;
	const shortModel = (name?: string) => name?.split("/").pop() ?? "…";
	const barButton = "cursor-pointer rounded px-2 py-1 text-[13px] text-bar-ink hover:bg-white/10";

	return (
		// The status bar takes its height; the workspace gets exactly the rest, so the drawer can never outgrow the window.
		<div className="flex h-dvh flex-col overflow-hidden">
			<header className="flex flex-wrap items-center gap-x-5 gap-y-1 bg-bar px-4 py-2 text-bar-ink">
				<h1 className="display text-[22px] leading-none font-extrabold">Tower</h1>
				<ConnectionBadge connection={board.error ? "reconnecting" : connection} />
				<p className="flex items-baseline gap-4 text-[13px] text-bar-dim">
					<span>
						<b className="font-semibold text-bar-ink">{running}</b> running
					</span>
					<span className={waiting > 0 ? "font-semibold text-caution" : ""}>
						<b className={`font-semibold ${waiting > 0 ? "" : "text-bar-ink"}`}>{waiting}</b> {waiting === 1 ? "needs" : "need"} you
					</span>
					<span>
						<b className="font-semibold text-bar-ink">{cards.length}</b> {cards.length === 1 ? "card" : "cards"}
					</span>
				</p>
				<div className="ml-auto flex items-center gap-1">
					<button type="button" onClick={() => setShowingModels((on) => !on)} aria-expanded={showingModels} className={barButton} title="Which model runs each stage">
						<span className="text-bar-dim">Plans with </span>
						<span className="font-mono text-[12px]">{shortModel(settings.data?.models.planning.model)}</span>
						<span className="text-bar-dim">, builds with </span>
						<span className="font-mono text-[12px]">{shortModel(settings.data?.models.building.model)}</span>
					</button>
					<button type="button" onClick={cycleTheme} className={barButton} title="Switch between following your system, light and dark">
						Theme: {theme === "auto" ? "system" : theme}
					</button>
				</div>
			</header>

			<div className={`grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] ${selectedCardId ? "lg:grid-cols-[minmax(0,1fr)_minmax(30rem,44vw)]" : ""}`}>
				<main className={`min-h-0 overflow-y-auto p-4 ${selectedCardId ? "hidden lg:block" : ""}`}>
					{board.error && (
						<p className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-danger">
							Cannot reach Tower's daemon: {board.error.message}. Start it with <span className="font-mono text-[13px]">/tower</span> in pi.
						</p>
					)}
					{showingModels && <ModelSettings onDone={() => setShowingModels(false)} />}
					<div className="flex flex-col gap-4">
						{projects.length > 0 && <Board projects={projects} cards={cards} selectedCardId={selectedCardId} onOpen={setSelectedCardId} />}
						<NewProject first={projects.length === 0 && !board.isPending} />
					</div>
				</main>

				{selectedCardId && (
					<div className="min-h-0 border-l border-rule">
						<Drawer key={selectedCardId} cardId={selectedCardId} onClose={() => setSelectedCardId(null)} onRunOpen={onRunOpen} />
					</div>
				)}
			</div>
		</div>
	);
}

function ConnectionBadge({ connection }: { connection: Connection }) {
	const live = connection === "live";
	return (
		<span className="flex items-center gap-1.5 text-[13px]" title={live ? "The board is receiving live updates from the daemon" : "Not hearing from the daemon; what you see may be out of date"}>
			<span aria-hidden className={`size-2 rounded-full ${live ? "bg-ok" : "pulse bg-caution"}`} />
			<span className={live ? "text-bar-dim" : "font-semibold text-caution"}>{live ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting"}</span>
		</span>
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
