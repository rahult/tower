import { useState } from "react";

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
