import type { Card } from "@traffic-control/core";

/** Strip tint encodes state, the way real strip colours encode flight type. */
export type Tint = "buff" | "sky" | "signal" | "rose" | "sage";

export const TINT_CLASS: Record<Tint, string> = {
	buff: "bg-buff",
	sky: "bg-sky",
	signal: "bg-signal",
	rose: "bg-rose",
	sage: "bg-sage",
};

const STATUS: Record<Card["status"], { label: string; tint: Tint }> = {
	idle: { label: "Idle", tint: "buff" },
	queued: { label: "Queued", tint: "sky" },
	running: { label: "Running", tint: "sky" },
	verifying: { label: "Checking", tint: "sky" },
	awaiting_gate: { label: "Waiting for approval", tint: "signal" },
	awaiting_input: { label: "Waiting for your answer", tint: "signal" },
	needs_attention: { label: "Needs attention", tint: "signal" },
	paused: { label: "Paused", tint: "buff" },
	interrupted: { label: "Interrupted", tint: "signal" },
	abandoned: { label: "Abandoned", tint: "rose" },
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

export function describeCard(card: Card): { stage: string; status: string; tint: Tint } {
	const status = STATUS[card.status];
	return { stage: STAGE_LABEL[card.stage], status: status.label, tint: card.stage === "done" ? "sage" : status.tint };
}

export const isLive = (card: Card) => card.status === "running" || card.status === "verifying";
