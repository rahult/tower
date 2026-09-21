import type { Card } from "@tower/core";

/**
 * Annunciator semantics, the same everywhere: work = an agent is running (blue), caution = needs you (amber),
 * ok = clear (green), danger = stopped for good (red), rest = nothing happening (neutral).
 */
export type Tone = "rest" | "work" | "caution" | "ok" | "danger";

export const BAR_CLASS: Record<Tone, string> = {
	rest: "bg-rule",
	work: "bg-primary",
	caution: "bg-caution/60",
	ok: "bg-ok",
	danger: "bg-danger",
};

export const CHIP_CLASS: Record<Tone, string> = {
	rest: "bg-wash text-slate",
	work: "bg-primary-soft text-primary",
	caution: "bg-caution-soft text-caution-text",
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

/** One sentence per column, shown on hover: the bare stage name assumes too much of a first-timer. */
export const STAGE_DESCRIPTIONS: Record<Card["stage"], string> = {
	backlog: "Work you have queued up, not yet started.",
	planning: "An agent is exploring the repository and writing a plan.",
	building: "An agent is writing the code from the plan, in the card's own worktree.",
	testing: "The verify command (or an agent) judges the build; failures go back to the builder.",
	feedback: "Reviews have run and their findings are waiting for your approval before a pull request.",
	pull_request: "The pull request is open; Tower watches CI and repairs failures up to a cap.",
	done: "Merged, or finished with the branch ready to merge.",
};

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
