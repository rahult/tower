import { useEffect, useState } from "react";

export type Theme = "auto" | "light" | "dark";
const KEY = "tower-theme";

function read(): Theme {
	try {
		const stored = localStorage.getItem(KEY);
		return stored === "light" || stored === "dark" ? stored : "auto";
	} catch {
		return "auto";
	}
}

/** "auto" leaves the attribute off, so the stylesheet follows the OS. */
export function applyTheme(theme: Theme = read()): void {
	if (theme === "auto") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = theme;
}

function persist(theme: Theme): void {
	try {
		localStorage.setItem(KEY, theme);
	} catch {
		// Private windows can refuse storage; the choice then lasts for this visit.
	}
}

export function useTheme(): [Theme, () => void, (theme: Theme) => void] {
	const [theme, setThemeState] = useState<Theme>(read);
	const setTheme = (next: Theme) => {
		persist(next);
		applyTheme(next);
		setThemeState(next);
	};
	const cycle = () => setTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto");
	return [theme, cycle, setTheme];
}

/** True while the OS is in dark mode; decides which moon/sun the theme button shows when theme is "auto". */
export const usePrefersDark = () => useMediaBool("(prefers-color-scheme: dark)");

function useMediaBool(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const list = window.matchMedia(query);
		const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
		setMatches(list.matches);
		list.addEventListener("change", onChange);
		return () => list.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

const DENSITY_KEY = "tower-density";

function readDensity(): "standard" | "compact" {
	try {
		return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "standard";
	} catch {
		return "standard";
	}
}

export function applyDensity(density: "standard" | "compact"): void {
	if (density === "compact") document.documentElement.dataset.density = "compact";
	else delete document.documentElement.dataset.density;
}

/** Standard or compact spacing. Type never changes size; only the density variables tighten. */
export function useDensity(): ["standard" | "compact", () => void] {
	const [density, setDensity] = useState<"standard" | "compact">(readDensity);
	const toggle = () => {
		const next = density === "compact" ? "standard" : "compact";
		try {
			localStorage.setItem(DENSITY_KEY, next);
		} catch {
			// Storage refused; the choice lasts for this visit.
		}
		applyDensity(next);
		setDensity(next);
	};
	return [density, toggle];
}
