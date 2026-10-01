import { useCallback, useEffect, useState } from "react";

export type View = "focus" | "board" | "projects" | "memory" | "flows" | "usage" | "review" | "research";

export interface Route {
	view: View;
	/** A card open in the drawer, over whichever view is active. */
	cardId: string | null;
	/** The project whose memory graph is open — set only for the memory view. */
	projectId: string | null;
}

/** "#board" → the board; "#card/<id>" → Focus with that card open; "#memory/<id>" → that project's memory; no hash → Focus. */
function parse(): Route {
	const hash = window.location.hash.replace(/^#/, "");
	const [head, tail] = hash.split("/");
	if (head === "board" || head === "projects" || head === "flows" || head === "usage" || head === "review" || head === "research") return { view: head, cardId: null, projectId: null };
	if (head === "memory") return { view: "memory", cardId: null, projectId: tail ?? null };
	if (head === "card" && tail) return { view: "focus", cardId: tail, projectId: null };
	return { view: "focus", cardId: null, projectId: null };
}

const VIEWS: ReadonlySet<string> = new Set(["focus", "board", "projects", "memory", "flows", "usage", "review", "research"]);

/** The view and open card, as a deep-linkable hash. Back and forward both work. */
export function useRoute(): [Route, (route: Partial<Route>) => void] {
	const [route, setRoute] = useState<Route>(parse);
	useEffect(() => {
		const onHash = () => setRoute(parse());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);
	const navigate = useCallback((next: Partial<Route>) => {
		const merged = { ...parse(), ...next };
		const hash = merged.cardId
			? `#card/${merged.cardId}`
			: merged.view === "focus"
				? ""
				: merged.view === "memory" && merged.projectId
					? `#memory/${merged.projectId}`
					: `#${merged.view}`;
		// An invalid view name (or a stale hash) is corrected by writing the canonical form back.
		if (!VIEWS.has(merged.view)) merged.view = "focus";
		if (window.location.hash !== hash) window.location.hash = hash;
		else setRoute(merged);
	}, []);
	return [route, navigate];
}
