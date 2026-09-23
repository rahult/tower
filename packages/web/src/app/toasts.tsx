/**
 * Toasts: short confirmations at the bottom of the window for actions that just happened somewhere
 * else than where you are looking. They carry no undo — the actions behind them are real.
 */
import { useEffect, useState } from "react";

interface Toast {
	id: number;
	message: string;
}

let nextId = 1;
const listeners = new Set<(toast: Toast) => void>();

export function toast(message: string): void {
	const t = { id: nextId++, message };
	for (const listener of listeners) listener(t);
}

export function ToastHost() {
	const [toasts, setToasts] = useState<Toast[]>([]);
	useEffect(() => {
		const onToast = (t: Toast) => {
			setToasts((current) => [...current.slice(-2), t]);
			setTimeout(() => setToasts((current) => current.filter((x) => x.id !== t.id)), 3500);
		};
		listeners.add(onToast);
		return () => {
			listeners.delete(onToast);
		};
	}, []);
	if (toasts.length === 0) return null;
	return (
		<div className="toasts" aria-label="Notifications">
			{toasts.map((t) => (
				<div key={t.id} className="toast" role="status">
					<span>{t.message}</span>
				</div>
			))}
		</div>
	);
}
