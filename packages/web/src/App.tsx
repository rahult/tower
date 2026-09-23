import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api/client.ts";
import { type Connection, useConnection, useEventStream } from "./api/stream.ts";
import { isLive, needsYou } from "./board/status.ts";
import { Modal, formatMoney, formatTokens } from "./app/bits.tsx";
import { Icon, IconSprite } from "./app/icons.tsx";
import { Palette, useShortcuts } from "./app/palette.tsx";
import { announceAttention, enableNotifications, notifyEnabled, setNotifyEnabled, setNotifyOpener } from "./app/notifications.ts";
import { QuickAdd } from "./app/quickadd.tsx";
import { useRoute, type View } from "./app/route.ts";
import { setTabUrgency } from "./app/tab.ts";
import { ToastHost } from "./app/toasts.tsx";
import { Board } from "./board/Board.tsx";
import { Drawer } from "./card/Drawer.tsx";
import { Focus } from "./focus/Focus.tsx";
import { Projects } from "./projects/Projects.tsx";
import { ModelSettings } from "./settings/ModelSettings.tsx";
import { Usage } from "./usage/Usage.tsx";
import { useDensity, usePrefersDark, useTheme, type Theme } from "./theme.ts";

const VIEW_ORDER: View[] = ["focus", "board", "projects", "usage"];
const VIEW_ICON = { focus: "focus", board: "board", projects: "folder", usage: "chart" } as const;
const VIEW_LABEL: Record<View, string> = { focus: "Tower", board: "Board", projects: "Projects", usage: "Usage" };

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
	const [density, toggleDensity] = useDensity();
	const prefersDark = usePrefersDark();
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

	// The inspector is one surface for the whole app: Tower keeps it docked even when nothing is open;
	// the other views dock it only while a card is open.
	const inspector = route.cardId ? (
		<Drawer key={route.cardId} cardId={route.cardId} projects={projects} onClose={() => navigate({ cardId: null })} onRunOpen={onRunOpen} />
	) : route.view === "focus" ? (
		<aside className="inspector" aria-label="Card">
			<div className="insp-empty">
				<strong>Nothing open</strong>
				<span>Select a card to read its session, plan and changes here.</span>
			</div>
		</aside>
	) : null;

	return (
		<div className="app">
			<IconSprite />
			<header className="strip" role="banner">
				<div className="brand" aria-label="Tower">
					<Icon name="tower" className="icon mark" />
					<span className="txt">Tower</span>
				</div>
				<nav className="nav" aria-label="Views">
					{VIEW_ORDER.map((view, index) => (
						<button key={view} type="button" onClick={() => navigate({ view, cardId: null })} aria-current={route.view === view ? "page" : undefined} title={`${VIEW_LABEL[view]} (⌘${index + 1})`}>
							<Icon name={VIEW_ICON[view]} />
							<span className="txt">{VIEW_LABEL[view]}</span>
							{view === "focus" && waiting > 0 && <span className="count">{waiting}</span>}
						</button>
					))}
				</nav>
				<div className="telemetry" aria-label="Live telemetry">
					<div className="tele">
						<span className="v">
							<span className="slots" aria-hidden>
								{Array.from({ length: Math.max(4, running) }, (_, i) => (
									<span key={i} className={`slot${i < running ? " on" : ""}`} />
								))}
							</span>
						</span>
						<span className="k">{running} running</span>
					</div>
					{today && (
						<div className="tele">
							<span className="v tnum">{formatTokens(today.tokens)}</span>
							<span className="k">tokens today</span>
						</div>
					)}
					{today && today.costUsd > 0 && (
						<div className="tele">
							<span className="v tnum">{formatMoney(today.costUsd)}</span>
							<span className="k">cost today</span>
						</div>
					)}
					<ConnectionBadge connection={board.error ? "reconnecting" : connection} />
				</div>
				<div className="actions">
					<button type="button" id="btn-add" onClick={() => setAddingWork({})} className="btn primary" title="Add work (n)">
						<Icon name="plus" />
						<span className="txt">Add work</span>
						<span className="kbd">n</span>
					</button>
					<button type="button" onClick={() => setPaletteOpen(true)} className="iconbtn" title="Command palette (⌘K)" aria-label="Open the command palette (⌘K)">
						<Icon name="search" className="icon icon-lg" />
					</button>
					<button type="button" onClick={toggleNotify} aria-pressed={notify} className="iconbtn" title={notify ? "Notifications are on: a card that needs you pings you while the tab is hidden" : "Turn on browser notifications for cards that need you"}>
						<Icon name="bell" className="icon icon-lg" />
					</button>
					<button type="button" onClick={toggleDensity} aria-pressed={density === "compact"} className="iconbtn" title={density === "compact" ? "Switch to standard density" : "Switch to compact density"}>
						<Icon name={density === "compact" ? "density-compact" : "density"} className="icon icon-lg" />
					</button>
					<button type="button" onClick={cycleTheme} className="iconbtn" title={`Theme: ${theme}`} aria-label={`Theme is ${theme}; click for the next one`}>
						<Icon name={(theme === "auto" ? prefersDark : theme === "dark") ? "sun" : "moon"} className="icon icon-lg" />
					</button>
				</div>
			</header>

			<div className={`grid h-full min-h-0 ${board.error ? "grid-rows-[auto_minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)]"}`}>
				{board.error && (
					<p className="border-b border-danger/40 bg-danger-soft px-4 py-2 text-[14px] text-danger">
						Cannot reach Tower's daemon: {board.error.message}. Start it with <span className="font-mono text-[13px]">/tower</span> in pi.
					</p>
				)}
				<div className="body" data-view={route.view} data-inspector={route.view === "focus" || route.cardId ? "docked" : "hidden"}>
					<div className="views">
						{board.isPending && <p className="p-4 text-[14px] text-slate">Connecting to the Tower daemon…</p>}
						{board.data && route.view === "focus" && (
							<Focus projects={projects} cards={cards} activeRuns={board.data.activeRuns} selectedCardId={route.cardId} onOpen={openCard} onAddWork={(projectId) => setAddingWork({ projectId })} onOpenModels={() => setModelsOpen(true)} />
						)}
						{board.data && route.view === "board" && <Board projects={projects} cards={cards} activeRuns={board.data.activeRuns} selectedCardId={route.cardId} onOpen={openCard} />}
						{board.data && route.view === "projects" && <Projects projects={projects} cards={cards} usage={usage.data} onAddWork={(projectId) => setAddingWork({ projectId })} />}
						{board.data && route.view === "usage" && <Usage onOpenCard={openCard} cardTitles={titles} projectNames={names} />}
					</div>
					{inspector}
				</div>
			</div>

			{paletteOpen && <Palette cards={cards} projectNames={names} actions={paletteActions} onClose={() => setPaletteOpen(false)} />}
			{addingWork && <QuickAdd projects={projects} presetProjectId={addingWork.projectId} onClose={() => setAddingWork(null)} onOpenCard={openCard} />}
			{modelsOpen && (
				<Modal title="Models" onClose={() => setModelsOpen(false)} wide>
					<ModelSettings onDone={() => setModelsOpen(false)} />
				</Modal>
			)}
			<ToastHost />
			<div role="status" aria-live="polite" className="sr-only">
				{waiting > 0 ? `${waiting} ${waiting === 1 ? "card needs" : "cards need"} your attention` : "Nothing needs your attention"}
			</div>
		</div>
	);
}

function ConnectionBadge({ connection }: { connection: Connection }) {
	const live = connection === "live";
	return (
		<span className="conn" title={live ? "The board is receiving live updates from the daemon" : "Not hearing from the daemon; what you see may be out of date"}>
			<span aria-hidden className={`dot ${live ? "ok" : "warn pulse"}`} />
			<span>{live ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting"}</span>
		</span>
	);
}
