import { useEffect, useMemo, useRef, useState } from "react";
import type { Card } from "@tower/core";
import type { View } from "./route.ts";

export interface PaletteActions {
	goToView: (view: View) => void;
	openCard: (cardId: string) => void;
	startCard: (cardId: string) => void;
	addWork: () => void;
	addProject: () => void;
	/** The free-form ask: one line of natural language, an @name tagging the project. */
	askTower: (text: string) => void;
	sendFeedback: () => void;
	openModels: () => void;
	setTheme: (theme: "auto" | "light" | "dark") => void;
	toggleNotify: () => void;
	toggleDensity: () => void;
	/** Narrow the stream to one project; null shows everything. */
	filterProject: (projectId: string | null) => void;
	/** What the density command should say, so the label matches the current state. */
	densityCompact: boolean;
}

interface Item {
	group: string;
	label: string;
	hint?: string;
	run: () => void;
}

/** Every command in one type-to-run box. ⌘K or / opens it; arrows choose; Enter runs. */
export function Palette({ cards, projectNames, projects, actions, onClose }: { cards: Card[]; projectNames: Map<string, string>; projects: Array<{ id: string; name: string }>; actions: PaletteActions; onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [picked, setPicked] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLUListElement>(null);

	const items = useMemo(() => {
		const commands: Item[] = [
			{ group: "Commands", label: "Add work…", hint: "n", run: actions.addWork },
			{ group: "Commands", label: "Add a project…", hint: "pick a repository directory", run: actions.addProject },
			{ group: "Commands", label: "Send feedback…", hint: "bug, idea, praise", run: actions.sendFeedback },
			{ group: "Commands", label: "Model settings…", hint: "which model runs each stage", run: actions.openModels },
			{ group: "Commands", label: "Notify me when a card needs attention", hint: "browser notifications", run: actions.toggleNotify },
			{ group: "Commands", label: actions.densityCompact ? "Standard density" : "Compact density", run: actions.toggleDensity },
			{ group: "Theme", label: "Follow the system", run: () => actions.setTheme("auto") },
			{ group: "Theme", label: "Light", run: () => actions.setTheme("light") },
			{ group: "Theme", label: "Dark", run: () => actions.setTheme("dark") },
		];
		const views: Item[] = (["focus", "board", "projects", "usage"] as View[]).map((view) => ({
			group: "Go to",
			label: view === "focus" ? "Tower" : view.charAt(0).toUpperCase() + view.slice(1),
			hint: "⌘" + (["focus", "board", "projects", "usage"].indexOf(view) + 1),
			run: () => actions.goToView(view),
		}));
		const filters: Item[] = [
			{ group: "Filter", label: "All projects", run: () => actions.filterProject(null) },
			...projects.map((project) => ({ group: "Filter", label: project.name, run: () => actions.filterProject(project.id) })),
		];
		// Backlog cards appear once, under "Start a backlog card" — not twice in the same list.
		const open: Item[] = cards
			.filter((card) => card.stage !== "done" && !(card.stage === "backlog" && card.status === "idle"))
			.map((card) => ({
				group: "Cards",
				label: card.title,
				hint: projectNames.get(card.projectId),
				run: () => actions.openCard(card.id),
			}));
		const start: Item[] = cards
			.filter((card) => card.stage === "backlog" && card.status === "idle")
			.map((card) => ({
				group: "Start a backlog card",
				label: card.title,
				hint: projectNames.get(card.projectId),
				run: () => actions.startCard(card.id),
			}));
		return [...commands, ...views, ...filters, ...open, ...start];
	}, [cards, projectNames, projects, actions]);

	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return items;
		const found = items.filter((item) => `${item.label} ${item.group} ${item.hint ?? ""}`.toLowerCase().includes(q));
		// An @tag is an explicit ask, and so is a line that matches nothing: put the agent's ear first.
		const trimmed = query.trim();
		if (trimmed.length >= 2 && (/@/.test(trimmed) || found.length === 0)) {
			return [
				{ group: "Ask Tower", label: `“${trimmed}”`, hint: "an agent reads this and acts", run: () => actions.askTower(trimmed) },
				...found,
			];
		}
		return found;
	}, [items, query, actions]);

	// Block bodies on purpose: an arrow-body effect returns whatever its last expression evaluates to, and
	// React calls that return value as a cleanup on unmount — a non-function there whites out the page.
	useEffect(() => {
		setPicked(0);
	}, [query]);
	useEffect(() => {
		input.current?.focus();
	}, []);
	// Keep the choice in view when the arrows move it.
	useEffect(() => {
		list.current?.children[picked]?.scrollIntoView({ block: "nearest" });
	}, [picked]);

	const runPicked = (index: number) => {
		const item = matches[index];
		if (!item) return;
		onClose();
		item.run();
	};

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setPicked((n) => Math.min(n + 1, matches.length - 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setPicked((n) => Math.max(n - 1, 0));
		} else if (event.key === "Enter") {
			event.preventDefault();
			runPicked(picked);
		} else if (event.key === "Escape") {
			// The drawer listens for Escape on the window to close itself. Once this palette has unmounted, its
			// "is a dialog open?" guard passes — so without stopping the event here, one Escape closes both.
			event.nativeEvent.stopPropagation();
			onClose();
		}
	};

	return (
		<div className="fixed inset-0 z-50">
			<div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()} />
			<div role="dialog" aria-modal="true" aria-label="Command palette" className="palette">
				<div className="in">
					<svg className="icon" aria-hidden="true">
						<use href="#i-search" />
					</svg>
					<input
						ref={input}
						id="palette-input"
						role="combobox"
						aria-expanded="true"
						aria-controls="palette-list"
						aria-activedescendant={matches[picked] ? `palette-opt-${picked}` : undefined}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder="Jump to a card, add work, or ask — @project tags it…"
						aria-label="Search commands"
						spellCheck={false}
						autoComplete="off"
					/>
					<span className="kbd">esc</span>
				</div>
				{matches.length === 0 ? (
					<p className="px-4 py-6 text-center text-[14px] text-slate">Nothing matches “{query}”.</p>
				) : (
					<ul ref={list} id="palette-list" role="listbox" aria-labelledby="palette-input">
						{matches.map((item, index) => (
							<li key={`${item.group}-${item.label}`} id={`palette-opt-${index}`} role="option" aria-selected={index === picked}>
								<button type="button" onMouseEnter={() => setPicked(index)} onClick={() => runPicked(index)} aria-selected={index === picked}>
									<span className="g">{item.group}</span>
									<span className="min-w-0 flex-1 truncate">{item.label}</span>
									{item.hint && <span className="max-w-[10rem] shrink truncate text-[12.5px] text-slate">{item.hint}</span>}
								</button>
							</li>
						))}
					</ul>
				)}
				<div className="foot">
					<span>
						<span className="kbd">↑↓</span> move
					</span>
					<span>
						<span className="kbd">↵</span> run
					</span>
					<span>
						<span className="kbd">j</span>/<span className="kbd">k</span> cards
					</span>
					<span>
						<span className="kbd">a</span> approve
					</span>
					<span>
						<span className="kbd">n</span> add
					</span>
				</div>
			</div>
		</div>
	);
}

export interface Shortcuts {
	palette: () => void;
	view: (index: number) => void;
	add: () => void;
	move: (dir: 1 | -1) => void;
	approve: () => void;
}

/**
 * The whole board, keyboard-first: ⌘K or / opens the command box, ⌘1–4 switches views, n adds work,
 * j/k walk through the visible cards, a approves the open card. Keys are ignored while typing in a field.
 */
export function useShortcuts(map: Shortcuts): void {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
			const mod = event.metaKey || event.ctrlKey;
			if (mod && event.key.toLowerCase() === "k") {
				event.preventDefault();
				map.palette();
			} else if (mod && ["1", "2", "3", "4"].includes(event.key)) {
				event.preventDefault();
				map.view(Number(event.key) - 1);
			} else if (!typing && !mod && !event.altKey) {
				if (event.key === "n" || event.key === "N" || event.key === "c" || event.key === "C") {
					event.preventDefault();
					map.add();
				} else if (event.key === "/") {
					event.preventDefault();
					map.palette();
				} else if (event.key === "j") {
					event.preventDefault();
					map.move(1);
				} else if (event.key === "k") {
					event.preventDefault();
					map.move(-1);
				} else if (event.key === "a") {
					event.preventDefault();
					map.approve();
				}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [map]);
}
