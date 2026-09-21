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

export function useTheme(): [Theme, () => void] {
	const [theme, setTheme] = useState<Theme>(read);
	const cycle = () => {
		const next: Theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
		try {
			localStorage.setItem(KEY, next);
		} catch {
			// Private windows can refuse storage; the choice then lasts for this visit.
		}
		applyTheme(next);
		setTheme(next);
	};
	return [theme, cycle];
}
