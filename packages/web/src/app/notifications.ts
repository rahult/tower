import type { Card } from "@tower/core";
import { describeCard } from "../board/status.ts";

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
	const on = setNotifyEnabled(true);
	// One ping right away, so turning the bell on visibly does something.
	if (on) ping("Tower: notifications on", "You'll get one of these here whenever a card needs you while this tab is hidden.");
	return on;
}

let openCard: ((cardId: string) => void) | null = null;
export function setNotifyOpener(fn: (cardId: string) => void): void {
	openCard = fn;
}

/** Cards already pinged during this stretch with the tab hidden, so steady amber does not nag. */
const pinged = new Set<string>();

/**
 * Fired from App as the board changes and again whenever the tab hides: while the tab is hidden and
 * notifications are on, every card that needs you gets one ping until it is handled. On a visible
 * board the board itself is the notification.
 */
export function announceAttention(cards: Card[], on: boolean): void {
	if (!on || document.visibilityState !== "hidden") {
		pinged.clear();
		return;
	}
	for (const card of duePings(cards, pinged)) {
		ping(`Tower: ${card.title}`, card.needsAttentionReason || describeCard(card).status, card.id);
	}
}

/**
 * Which of these cards should ping right now, updating `pinged` in place: every card that needs you
 * which has not pinged during this hidden stretch. A card that no longer needs you re-arms, so it
 * pings again if it comes back needing you.
 */
export function duePings(cards: Card[], pinged: Set<string>): Card[] {
	const due: Card[] = [];
	for (const card of cards) {
		if (describeCard(card).tone !== "caution") {
			pinged.delete(card.id);
			continue;
		}
		if (pinged.has(card.id)) continue;
		pinged.add(card.id);
		due.push(card);
	}
	return due;
}

function ping(title: string, body: string, cardId?: string): void {
	try {
		const notice = new Notification(title, { body, tag: cardId ? `tower-${cardId}` : "tower" });
		notice.onclick = () => {
			window.focus();
			if (cardId) openCard?.(cardId);
			notice.close();
		};
	} catch {
		// Some browsers construct Notification lazily; a missed ping is not an error worth breaking on.
	}
}
