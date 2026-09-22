import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api/client.ts";
import { type Connection, useConnection, useEventStream } from "./api/stream.ts";
import { isLive, needsYou } from "./board/status.ts";
import { Modal } from "./app/bits.tsx";
import { Palette, useShortcuts } from "./app/palette.tsx";
import { announceAttention, enableNotifications, notifyEnabled, setNotifyEnabled, setNotifyOpener } from "./app/notifications.ts";
import { QuickAdd } from "./app/quickadd.tsx";
import { useRoute, type View } from "./app/route.ts";
import { setTabUrgency } from "./app/tab.ts";
import { Board } from "./board/Board.tsx";
import { Drawer } from "./card/Drawer.tsx";
import { Focus } from "./focus/Focus.tsx";
import { formatTokens } from "./projects/Projects.tsx";
import { Projects } from "./projects/Projects.tsx";
import { ModelSettings } from "./settings/ModelSettings.tsx";
import { Usage } from "./usage/Usage.tsx";
import { useTheme, type Theme } from "./theme.ts";
import { button } from "./ui.ts";

const VIEW_ORDER: View[] = ["focus", "board", "projects", "usage"];

export function App() {
	const board = useQuery({ queryKey: ["board"], queryFn: api.board });
	// Refetched with the board, so today's spend keeps up with finished sessions.
	const usage = useQuery({ queryKey: ["board", "usage"], queryFn: api.usage });
	const today = usage.data?.byDay.find((row) => row.key === new Date().toLocaleDateString("en-CA"));
	const [route, navigate] = useRoute();
	const [openRunId, setOpenRunId] = useState<string | null>(null);
	useEventStream(openRunId);
	const connection = useConnection();
	const onRunOpen = useCallback((runId: string | null) => setOpenRunId(runId), []);
	const openCard = useCallback((cardId: string) => navigate({ cardId }), [navigate]);

	const [paletteOpen, setPaletteOpen] = useState(false);
	const [addingWork, setAddingWork] = useState<null | { projectId?: string }>(null);
	const [modelsOpen, setModelsOpen] = useState(false);
	const [theme, cycleTheme, setTheme] = useTheme();
	const [notify, setNotify] = useState(notifyEnabled);

	const projects = board.data?.projects ?? [];
	const cards = board.data?.cards ?? [];
	const waiting = cards.filter(needsYou).length;
	const running = cards.filter(isLive).length;
	const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
	const titles = useMemo(() => new Map(cards.map((card) => [card.id, card.title])), [cards]);

	// A pinned tab should say what the board wants, without being opened.
	useEffect(() => setTabUrgency(waiting), [waiting]);

	// System notifications: while the tab is hidden, every card that needs you pings once.
	const queryClient = useQueryClient();
	useEffect(() => {
		announceAttention(cards, notify);
	}, [cards, notify]);
	useEffect(() => {
		if (!notify) return;
		const announce = () => {
			if (document.hidden) announceAttention(cards, true);
		};
		document.addEventListener("visibilitychange", announce);
		return () => document.removeEventListener("visibilitychange", announce);
	}, [cards, notify]);
	useEffect(() => {
		setNotifyOpener(openCard);
	}, [openCard]);

	const startCard = useCallback(
		(cardId: string) => {
			void api.enqueue(cardId).then(() => queryClient.invalidateQueries({ queryKey: ["board"] }));
		},
		[queryClient],
	);
	const toggleNotify = useCallback(() => {
		if (notify) {
			setNotifyEnabled(false);
			setNotify(false);
		} else {
			void enableNotifications().then(setNotify);
		}
	}, [notify]);
	const paletteActions = useMemo(
		() => ({
			goToView: (view: View) => navigate({ view, cardId: null }),
			openCard,
			startCard,
			addWork: () => setAddingWork({}),
			openModels: () => setModelsOpen(true),
			setTheme: (next: Theme) => setTheme(next),
			toggleNotify,
		}),
		[navigate, openCard, startCard, setTheme, toggleNotify],
	);
	useShortcuts(
		useMemo(
			() => ({
				palette: () => setPaletteOpen((open) => !open),
				view: (index: number) => navigate({ view: VIEW_ORDER[index] ?? "focus", cardId: null }),
				add: () => setAddingWork({}),
			}),
			[navigate],
		),
	);

	return (
		<div className="flex h-dvh flex-col overflow-hidden">
			<header className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-bar px-4 py-2 text-bar-ink">
				<button type="button" onClick={() => navigate({ view: "focus", cardId: null })} className="display cursor-pointer text-[22px] leading-none font-extrabold" title="Tower — everything on one board">
					Tower
				</button>
				<ConnectionBadge connection={board.error ? "reconnecting" : connection} />

				<nav aria-label="Views" className="flex items-center gap-0.5 rounded-md bg-white/8 p-0.5">
					{VIEW_ORDER.map((view, index) => (
						<button
							key={view}
							type="button"
							onClick={() => navigate({ view, cardId: null })}
							aria-current={route.view === view ? "page" : undefined}
							className={`flex cursor-pointer items-center gap-1.5 rounded px-2.5 py-1 text-[13px] font-medium capitalize ${route.view === view ? "bg-white/15 text-bar-ink" : "text-bar-dim hover:text-bar-ink"}`}
							title={`${view} (⌘${index + 1})`}
						>
							{view}
							{view === "focus" && waiting > 0 && <span className="rounded-full bg-caution px-1.5 font-mono text-[11px] font-bold text-caution-ink">{waiting}</span>}
						</button>
					))}
				</nav>

				<div className="ml-auto flex items-center gap-1">
					<button type="button" onClick={() => setAddingWork({})} className="mr-1 cursor-pointer rounded-md bg-primary px-2.5 py-1 text-[13px] font-bold text-primary-ink hover:brightness-110" title="Add work (n)">
						+ Add work
					</button>
					<button type="button" onClick={() => setPaletteOpen(true)} className={barButton} title="Command palette (⌘K)" aria-label="Open the command palette (⌘K)">
						<span className="font-mono text-[12px] text-bar-dim">⌘K</span>
					</button>
					{today && (
						<button type="button" onClick={() => navigate({ view: "usage" })} className={barButton} title="Tokens used by sessions started today. Subscription models report no cost." aria-label="Tokens used today — open Usage">
							<span className="text-bar-dim">Today </span>
							<span className="font-mono text-[12px]">{formatTokens(today.tokens)}</span>
							{today.costUsd > 0 && <span className="font-mono text-[12px]"> · ${today.costUsd.toFixed(2)}</span>}
						</button>
					)}
					<button type="button" onClick={toggleNotify} aria-pressed={notify} className={barButton} title={notify ? "Notifications are on: a card that needs you pings you while the tab is hidden" : "Turn on browser notifications for cards that need you"}>
						<span aria-hidden>{notify ? "🔔" : "🔕"}</span>
						<span className="text-bar-dim">{notify ? "On" : "Off"}</span>
					</button>
					<button type="button" onClick={() => setModelsOpen(true)} className={barButton} title="Which model runs each stage" aria-label="Model settings">
						<span className="text-bar-dim">Models</span>
					</button>
					<button type="button" onClick={cycleTheme} className={barButton} title="Switch between following your system, light and dark" aria-label={`Theme is ${theme}; click for the next one`}>
						<span className="text-bar-dim">Theme:</span> {theme}
					</button>
				</div>
			</header>

			<div className={`grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] ${route.cardId ? "lg:grid-cols-[minmax(0,1fr)_minmax(30rem,44vw)]" : ""}`}>
				<main className={`min-h-0 overflow-y-auto p-4 ${route.cardId ? "hidden lg:block" : ""}`}>
					{board.isPending && <p className="mx-auto mb-4 max-w-[64rem] animate-pulse text-[14px] text-slate">Connecting to the Tower daemon…</p>}
						{board.error && (
						<p className="mx-auto mb-4 max-w-[64rem] rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-danger">
							Cannot reach Tower's daemon: {board.error.message}. Start it with <span className="font-mono text-[13px]">/tower</span> in pi.
						</p>
					)}
					{board.data && route.view === "focus" && <Focus projects={projects} cards={cards} activeRuns={board.data.activeRuns} onOpen={openCard} onAddWork={(projectId) => setAddingWork({ projectId })} />}
					{board.data && route.view === "board" && <Board projects={projects} cards={cards} selectedCardId={route.cardId} onOpen={openCard} />}
					{board.data && route.view === "projects" && <Projects projects={projects} cards={cards} usage={usage.data} onOpen={openCard} onAddWork={(projectId) => setAddingWork({ projectId })} />}
					{board.data && route.view === "usage" && <Usage onOpenCard={openCard} cardTitles={titles} projectNames={names} />}
				</main>

				{route.cardId && (
					<div className="min-h-0 border-l border-rule">
						<Drawer key={route.cardId} cardId={route.cardId} projects={projects} onClose={() => navigate({ cardId: null })} onRunOpen={onRunOpen} />
					</div>
				)}
			</div>

			{paletteOpen && <Palette cards={cards} projectNames={names} actions={paletteActions} onClose={() => setPaletteOpen(false)} />}
			{addingWork && <QuickAdd projects={projects} presetProjectId={addingWork.projectId} onClose={() => setAddingWork(null)} onOpenCard={openCard} />}
			{modelsOpen && (
				<Modal title="Models" onClose={() => setModelsOpen(false)} wide>
					<ModelSettings onDone={() => setModelsOpen(false)} />
				</Modal>
			)}
			<div role="status" aria-live="polite" className="sr-only">
				{waiting > 0 ? `${waiting} ${waiting === 1 ? "card needs" : "cards need"} your attention` : "Nothing needs your attention"}
			</div>
		</div>
	);
}

const barButton = "cursor-pointer rounded px-2 py-1 text-[13px] text-bar-ink hover:bg-white/10";

function ConnectionBadge({ connection }: { connection: Connection }) {
	const live = connection === "live";
	return (
		<span className="flex items-center gap-1.5 text-[13px]" title={live ? "The board is receiving live updates from the daemon" : "Not hearing from the daemon; what you see may be out of date"}>
			<span aria-hidden className={`size-2 rounded-full ${live ? "bg-ok" : "pulse bg-caution"}`} />
			<span className={live ? "text-bar-dim" : "font-semibold text-caution"}>{live ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting"}</span>
		</span>
	);
}
