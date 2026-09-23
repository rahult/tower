import type { JSX } from "react";

/**
 * One sprite of stroke icons, ported from the Open Design mockup. Rendered once at the app root;
 * icons reference their symbol by id, so a repeat icon costs one <use>.
 */
export function IconSprite() {
	return (
		<svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
			<defs>
				<symbol id="i-tower" viewBox="0 0 24 24"><path d="M12 3v3M8 6h8l-2 6H10L8 6zM10 12l-1 9M14 12l1 9M9 21h6" /></symbol>
				<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></symbol>
				<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
				<symbol id="i-bell" viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0" /></symbol>
				<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></symbol>
				<symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></symbol>
				<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></symbol>
				<symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 5 5L20 7" /></symbol>
				<symbol id="i-back" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" /></symbol>
				<symbol id="i-play" viewBox="0 0 24 24"><path d="M7 5v14l11-7z" /></symbol>
				<symbol id="i-branch" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-12 2-12 6" /></symbol>
				<symbol id="i-pr" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="M6 7.5v9M18 16.5V10a3 3 0 0 0-3-3h-3M14 4l-2 3 2 3" /></symbol>
				<symbol id="i-ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></symbol>
				<symbol id="i-send" viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4-7-8-1z" /></symbol>
				<symbol id="i-retry" viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5" /></symbol>
				<symbol id="i-board" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></symbol>
				<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></symbol>
				<symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /></symbol>
				<symbol id="i-focus" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></symbol>
				<symbol id="i-density" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" /></symbol>
				<symbol id="i-density-compact" viewBox="0 0 24 24"><path d="M4 5h16M4 9.5h16M4 14h16M4 18.5h16" /></symbol>
				<symbol id="i-chev-l" viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></symbol>
				<symbol id="i-chev-r" viewBox="0 0 24 24"><path d="m10 6 6 6-6 6" /></symbol>
			</defs>
		</svg>
	);
}

export type IconName = "tower" | "search" | "plus" | "bell" | "sun" | "moon" | "x" | "check" | "back" | "play" | "branch" | "pr" | "ext" | "send" | "retry" | "board" | "folder" | "chart" | "focus" | "density" | "density-compact" | "chev-l" | "chev-r";

/** A stroke icon from the shared sprite; `className` defaults to the 16px `.icon` size. */
export function Icon({ name, className = "icon" }: { name: IconName; className?: string }): JSX.Element {
	return (
		<svg className={className} aria-hidden="true">
			<use href={`#i-${name}`} />
		</svg>
	);
}
