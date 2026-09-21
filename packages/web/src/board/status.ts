import type { Card } from "@tower/core";

/**
 * Annunciator semantics, the same everywhere: work = an agent is running (blue), caution = needs you (amber),
 * ok = clear (green), danger = stopped for good (red), rest = nothing happening (neutral).
 */
export type Tone = "rest" | "work" | "caution" | "ok" | "danger";

export const BAR_CLASS: Record<Tone, string> = {
	rest: "bg-rule",
	work: "bg-primary",
	caution: "bg-caution-ink/35",
	ok: "bg-ok",
	danger: "bg-danger",
};

export const CHIP_CLASS: Record<Tone, string> = {
	rest: "bg-wash text-slate",
	work: "bg-primary-soft text-primary",
	caution: "bg-caution-ink/12 text-caution-ink",
	ok: "bg-ok-soft text-ok",
	danger: "bg-danger-soft text-danger",
};

const STATUS: Record<Card["status"], { label: string; tone: Tone }> = {
	idle: { label: "Idle", tone: "rest" },
	queued: { label: "Queued", tone: "work" },
	running: { label: "Running", tone: "work" },
	verifying: { label: "Checking", tone: "work" },
	awaiting_gate: { label: "Waiting for approval", tone: "caution" },
	awaiting_input: { label: "Waiting for your answer", tone: "caution" },
	needs_attention: { label: "Needs attention", tone: "caution" },
	paused: { label: "Paused", tone: "rest" },
	interrupted: { label: "Interrupted", tone: "caution" },
	abandoned: { label: "Abandoned", tone: "danger" },
};

const STAGE_LABEL: Record<Card["stage"], string> = {
	backlog: "Backlog",
	planning: "Planning",
	building: "Building",
	testing: "Testing",
	feedback: "Feedback",
	pull_request: "Pull request",
	done: "Done",
};
export { STAGE_LABEL };

export function describeCard(card: Card): { stage: string; status: string; tone: Tone } {
	const status = STATUS[card.status];
	const stage = STAGE_LABEL[card.stage];
	if (card.stage === "done") return { stage, status: "Done", tone: "ok" };
	// An open pull request is not idle in any useful sense: Tower is watching it.
	if (card.stage === "pull_request" && card.status === "idle") return { stage, status: "Open, being watched", tone: "work" };
	return { stage, status: status.label, tone: status.tone };
}

export const isLive = (card: Card) => card.status === "running" || card.status === "verifying";
export const needsYou = (card: Card) => describeCard(card).tone === "caution";

export const STAGE_COLUMNS: Array<{ stage: Card["stage"]; label: string }> = (Object.keys(STAGE_LABEL) as Card["stage"][]).map((stage) => ({ stage, label: STAGE_LABEL[stage] }));
