import type { Card } from "@tower/core";
import { describeCard, type Tone } from "../board/status.ts";

const KEY = "tower-notify";

export function notifyEnabled(): boolean {
	try {
		return localStorage.getItem(KEY) === "on" && typeof Notification !== "undefined" && Notification.permission === "granted";
	} catch {
		return false;
	}
}

/** Turning it on asks the browser for permission; until it is granted this stays off. */
export function setNotifyEnabled(on: boolean): boolean {
	try {
		localStorage.setItem(KEY, on ? "on" : "off");
	} catch {
		// Private windows can refuse storage; the choice then lasts for this visit.
	}
	return notifyEnabled();
}

/** async because the first enable waits on the browser's permission prompt. */
export async function enableNotifications(): Promise<boolean> {
	if (typeof Notification === "undefined") return false;
	if (Notification.permission !== "granted") {
		const answer = await Notification.requestPermission();
		if (answer !== "granted") {
			setNotifyEnabled(false);
			return false;
		}
	}
	return setNotifyEnabled(true);
}

let openCard: ((cardId: string) => void) | null = null;
export function setNotifyOpener(fn: (cardId: string) => void): void {
	openCard = fn;
}

/**
 * Fired from App as the board changes: a card that has just turned amber gets a system notification,
 * but only while the tab is hidden — on a visible board the board itself is the notification.
 * `seen` is the caller's persistent map of the previous tone per card.
 */
export function announceAttention(cards: Card[], seen: Map<string, Tone>, on: boolean): void {
	for (const card of cards) {
		const tone = describeCard(card).tone;
		const before = seen.get(card.id);
		seen.set(card.id, tone);
		if (!on || !before || before === tone || tone !== "caution" || document.visibilityState !== "hidden") continue;
		try {
			const notice = new Notification(`Tower: ${card.title}`, {
				body: card.needsAttentionReason || describeCard(card).status,
				tag: `tower-${card.id}`,
			});
			notice.onclick = () => {
				window.focus();
				openCard?.(card.id);
				notice.close();
			};
		} catch {
			// Some browsers construct Notification lazily; a missed ping is not an error worth breaking on.
		}
	}
}
