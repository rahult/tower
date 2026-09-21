import { useCallback, useEffect, useState } from "react";

export type View = "focus" | "board" | "projects" | "usage";

export interface Route {
	view: View;
	/** A card open in the drawer, over whichever view is active. */
	cardId: string | null;
}

/** "#board" → the board; "#card/<id>" → Focus with that card open; no hash → Focus. */
function parse(): Route {
	const hash = window.location.hash.replace(/^#/, "");
	const [head, tail] = hash.split("/");
	if (head === "board" || head === "projects" || head === "usage") return { view: head, cardId: null };
	if (head === "card" && tail) return { view: "focus", cardId: tail };
	return { view: "focus", cardId: null };
}

const VIEWS: ReadonlySet<string> = new Set(["focus", "board", "projects", "usage"]);

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
		const hash = merged.cardId ? `#card/${merged.cardId}` : merged.view === "focus" ? "" : `#${merged.view}`;
		// An invalid view name (or a stale hash) is corrected by writing the canonical form back.
		if (!VIEWS.has(merged.view)) merged.view = "focus";
		if (window.location.hash !== hash) window.location.hash = hash;
		else setRoute(merged);
	}, []);
	return [route, navigate];
}
