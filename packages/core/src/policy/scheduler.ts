import type { Stage } from "../types.ts";

export interface ReadyCard {
	cardId: string;
	projectId: string;
	stage: Stage;
	priority: number;
	/** When the card joined the queue (ms). */
	queuedAt: number;
	/** How many times the card has been built; > 1 means it is coming back from a failed test. */
	buildAttempt: number;
}

export interface SchedulerState {
	/** Cards waiting for a slot. Never empty when pickNext is called with capacity left. */
	ready: ReadonlyArray<ReadyCard>;
	running: ReadonlyArray<{ cardId: string; projectId: string }>;
	caps: { global: number; perProject: Readonly<Record<string, number>> };
}

/** Cards that may start right now without breaking the global or per-project cap. The caps are not yours to bend. */
export function eligible(state: SchedulerState): ReadyCard[] {
	if (state.running.length >= state.caps.global) return [];
	const runningIn = (projectId: string) => state.running.filter((r) => r.projectId === projectId).length;
	return state.ready.filter((card) => runningIn(card.projectId) < (state.caps.perProject[card.projectId] ?? 1));
}

/**
 * Chooses which waiting card starts next, from the ones the caps allow. Called repeatedly until it returns null.
 *
 * The trade-off: round-robin across projects keeps every swimlane moving, but maximises work in progress and
 * the number of half-finished worktrees you are tracking. Finishing what is furthest along first gets things
 * done, but one busy project can starve the rest. And should a card coming back from a failed test jump the
 * queue (its worktree is warm, you want it finished) or go to the back (it is the one that is struggling)?
 *
 * TODO(rahul): replace this default (oldest first) with your own rule. Tests in test/scheduler.test.ts pin only
 * the contract: pick from `candidates`, or null when there are none.
 */
export function pickNext(candidates: ReadonlyArray<ReadyCard>, _state: SchedulerState): string | null {
	const [first] = [...candidates].sort((a, b) => a.queuedAt - b.queuedAt);
	return first?.cardId ?? null;
}
