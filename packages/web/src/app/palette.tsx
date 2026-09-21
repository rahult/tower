import { useEffect, useMemo, useRef, useState } from "react";
import type { Card } from "@tower/core";
import type { View } from "./route.ts";

export interface PaletteActions {
	goToView: (view: View) => void;
	openCard: (cardId: string) => void;
	startCard: (cardId: string) => void;
	addWork: () => void;
	openModels: () => void;
	setTheme: (theme: "auto" | "light" | "dark") => void;
	toggleNotify: () => void;
}

interface Item {
	group: string;
	label: string;
	hint?: string;
	run: () => void;
}

/** Every command in one type-to-run list. ⌘K opens it; arrows choose; Enter runs. */
export function Palette({ cards, projectNames, actions, onClose }: { cards: Card[]; projectNames: Map<string, string>; actions: PaletteActions; onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [picked, setPicked] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLUListElement>(null);

	const items = useMemo(() => {
		const commands: Item[] = [
			{ group: "Commands", label: "Add work…", hint: "new card for a project", run: actions.addWork },
			{ group: "Commands", label: "Model settings…", hint: "which model runs each stage", run: actions.openModels },
			{ group: "Commands", label: "Notify me when a card needs attention", hint: "browser notifications", run: actions.toggleNotify },
			{ group: "Theme", label: "Follow the system", run: () => actions.setTheme("auto") },
			{ group: "Theme", label: "Light", run: () => actions.setTheme("light") },
			{ group: "Theme", label: "Dark", run: () => actions.setTheme("dark") },
		];
		const views: Item[] = (["focus", "board", "projects", "usage"] as View[]).map((view) => ({
			group: "Go to",
			label: view.charAt(0).toUpperCase() + view.slice(1),
			run: () => actions.goToView(view),
		}));
		const open: Item[] = cards
			.filter((card) => card.stage !== "done")
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
		return [...commands, ...views, ...open, ...start];
	}, [cards, projectNames, actions]);

	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return items;
		return items.filter((item) => `${item.label} ${item.hint ?? ""}`.toLowerCase().includes(q));
	}, [items, query]);

	useEffect(() => setPicked(0), [query]);
	useEffect(() => input.current?.focus(), []);
	// Keep the choice in view when the arrows move it.
	useEffect(() => list.current?.children[picked]?.scrollIntoView({ block: "nearest" }), [picked]);

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
			onClose();
		}
	};

	let lastGroup = "";
	return (
		<div className="fixed inset-0 z-50 bg-black/40 p-4 pt-[12vh]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div role="dialog" aria-modal="true" aria-label="Command palette" className="pop mx-auto w-full max-w-[38rem] overflow-hidden rounded-xl border border-rule bg-sheet shadow-2xl">
				<input
					ref={input}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Type a command, a view, or a card…"
					aria-label="Search commands"
					spellCheck={false}
					className="w-full border-b border-rule bg-sheet px-4 py-3 text-[15px] outline-none placeholder:text-slate/70"
				/>
				{matches.length === 0 ? (
					<p className="px-4 py-6 text-center text-[14px] text-slate">Nothing matches “{query}”.</p>
				) : (
					<ul ref={list} className="max-h-[24rem] overflow-y-auto p-1.5" role="listbox">
						{matches.map((item, index) => {
							const header = item.group !== lastGroup ? ((lastGroup = item.group), item.group) : null;
							return (
								<li key={`${item.group}-${item.label}`} role="option" aria-selected={index === picked}>
									{header && <p className="px-2.5 pt-2.5 pb-1 text-[12px] font-semibold tracking-wide text-slate uppercase">{header}</p>}
									<button
										type="button"
										onMouseEnter={() => setPicked(index)}
										onClick={() => runPicked(index)}
										className={`flex w-full cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left text-[14px] ${index === picked ? "bg-primary-soft" : ""}`}
									>
										<span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
										{item.hint && <span className="max-w-[10rem] shrink truncate text-[12.5px] text-slate">{item.hint}</span>}
									</button>
								</li>
							);
						})}
					</ul>
				)}
				<p className="flex gap-4 border-t border-rule bg-wash px-4 py-2 text-[12.5px] text-slate">
					<span>↑↓ choose</span>
					<span>↵ run</span>
					<span>esc close</span>
				</p>
			</div>
		</div>
	);
}

export interface Shortcuts {
	palette: () => void;
	view: (index: number) => void;
	add: () => void;
}

/** Global shortcuts: ⌘K palette, ⌘1–4 views, "n" adds work. Keys are ignored while typing in a field. */
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
			} else if (!typing && !mod && !event.altKey && (event.key === "n" || event.key === "N")) {
				event.preventDefault();
				map.add();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [map]);
}
