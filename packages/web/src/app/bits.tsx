import { type ReactNode, useEffect, useState } from "react";

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
		<div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div role="dialog" aria-modal="true" aria-label={title} className={`pop mt-8 w-full ${wide ? "max-w-[52rem]" : "max-w-[34rem]"} rounded-xl border border-rule bg-sheet shadow-2xl`}>
				<header className="flex items-center justify-between gap-3 border-b border-rule px-5 py-3">
					<h2 className="display text-[19px] font-extrabold">{title}</h2>
					<button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer rounded px-2 py-0.5 text-slate hover:bg-wash hover:text-ink">
						✕
					</button>
				</header>
				<div className="p-5">{children}</div>
			</div>
		</div>
	);
}

/** A tray heading: the small caps title, a count, and room for a one-line hint on the right. */
export function TrayHeading({ label, count, tone, hint }: { label: string; count: number; tone: "caution" | "work" | "ok" | "rest"; hint?: string }) {
	const dot = { caution: "bg-caution", work: "bg-primary", ok: "bg-ok", rest: "bg-rule" }[tone];
	return (
		<div className="flex items-baseline gap-2">
			<span aria-hidden className={`size-2 rounded-full ${dot}`} />
			<h2 className="display text-[16px] font-extrabold tracking-wide uppercase">{label}</h2>
			<span className="font-mono text-[13px] font-medium text-slate tnum">{count}</span>
			{hint && <span className="ml-2 hidden text-[13px] text-slate md:block">{hint}</span>}
		</div>
	);
}

/** Seconds since `from`, re-rendered every second while `live`. */
export function useElapsed(from: number | undefined, live: boolean): string {
	const [, tick] = useState(0);
	useEffect(() => {
		if (!live || from === undefined) return;
		const timer = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, [live, from]);
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
