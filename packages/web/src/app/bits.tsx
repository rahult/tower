import { type ReactNode, useEffect, useRef, useState } from "react";
import { button } from "../ui.ts";
import { Icon } from "./icons.tsx";

/** A centred dialog over a dimmed backdrop. Esc and a backdrop click both close it. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<>
			<div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()} />
			<div role="dialog" aria-modal="true" aria-label={title} className={`dialog${wide ? " wide" : ""}`}>
				<header className="flex items-center justify-between gap-3">
					<h2>{title}</h2>
					<button type="button" onClick={onClose} aria-label="Close" className="iconbtn shrink-0">
						<Icon name="x" className="icon icon-lg" />
					</button>
				</header>
				{children}
			</div>
		</>
	);
}

/** Seconds since `from`, re-rendered on an interval while `live`. Ticks every second unless told otherwise. */
export function useElapsed(from: number | undefined, live: boolean, intervalMs = 1000): string {
	const [, tick] = useState(0);
	useEffect(() => {
		if (!live || from === undefined) return;
		const timer = setInterval(() => tick((n) => n + 1), intervalMs);
		return () => clearInterval(timer);
	}, [live, from, intervalMs]);
	return formatElapsed(from);
}

export function formatElapsed(from: number | undefined): string {
	if (from === undefined) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - from) / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** "zai/glm-5.3:low" → "glm-5.3" — the part a person recognises. */
export const shortModel = (name?: string) => name?.split("/").pop()?.split(":")[0] ?? "…";

/** Renders children after `delay` ms. Keeps a fast board from flashing loading states. */
export function usePastDelay(pending: boolean, delay = 250): boolean {
	const [past, setPast] = useState(false);
	useEffect(() => {
		if (!pending) {
			setPast(false);
			return;
		}
		const timer = setTimeout(() => setPast(true), delay);
		return () => clearTimeout(timer);
	}, [pending, delay]);
	return pending && past;
}

/**
 * A destructive action that asks twice: the first click arms it, the second fires, and arming
 * wears off after three seconds. One stray click can no longer kill a running session.
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, busy, small }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; busy?: boolean; small?: boolean }) {
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		if (!armed) return;
		const timer = setTimeout(() => setArmed(false), 3000);
		return () => clearTimeout(timer);
	}, [armed]);
	return (
		<button
			type="button"
			onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
			disabled={disabled || busy}
			aria-label={armed ? confirmLabel : label}
			className={`btn danger${armed ? " armed" : ""}${small ? " sm" : ""} whitespace-nowrap`}
		>
			{busy ? "…" : armed ? confirmLabel : label}
		</button>
	);
}

/** A mutation failure in the reader's language, with the way out one click away. */
export function ErrorNote({ error, onRetry }: { error: { message: string } | null; onRetry: () => void }) {
	if (!error) return null;
	const raw = error.message ?? String(error);
	// fetch failures arrive as browser internals; everything else is the daemon's own words.
	const friendly = /failed to fetch|networkerror|load failed/i.test(raw) ? "Cannot reach the Tower daemon — it may be restarting. Retry in a moment." : raw;
	return (
		<p className="rounded bg-danger-soft px-2 py-1 text-[13px] text-danger">
			{friendly}{" "}
			<button type="button" onClick={onRetry} className={`${button.link} !text-[13px]`}>
				Retry
			</button>
		</p>
	);
}

/** Subscribes to a media query; matches start true so first paint is already right. */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));
	useEffect(() => {
		const list = window.matchMedia(query);
		const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
		setMatches(list.matches);
		list.addEventListener("change", onChange);
		return () => list.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

export function formatTokens(tokens: number): string {
	return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

export function formatMoney(usd: number): string {
	return `$${usd.toFixed(2)}`;
}
