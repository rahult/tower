import type { GateKind } from "./policy/gates.ts";
import type { AgentStage, CardStatus, ResultStatus, Stage } from "./types.ts";

/** The slice of a card the lifecycle rules depend on. */
export interface CardState {
	stage: Stage;
	status: CardStatus;
	needsAttentionReason: string | null;
}

export type CardEvent =
	| { type: "enqueue" }
	| { type: "run_started" }
	| { type: "run_settled"; result: ResultStatus; summary: string; requiredGates: GateKind[] }
	| { type: "run_failed"; error: string }
	| { type: "run_aborted" }
	| { type: "gate_decided"; decision: "approve" | "reject"; feedback: string }
	| { type: "retry"; feedback?: string };

export type Effect = { type: "start_run"; stage: AgentStage; feedback?: string } | { type: "open_gate"; kind: GateKind };

export interface Transition {
	next: CardState;
	effects: Effect[];
}

export class InvalidTransition extends Error {
	constructor(card: CardState, event: CardEvent) {
		super(`Cannot apply "${event.type}" to a card that is ${card.stage}/${card.status}`);
	}
}

const AGENT_STAGES = new Set<Stage>(["planning", "building", "testing"]);
const isAgentStage = (stage: Stage): stage is AgentStage => AGENT_STAGES.has(stage);

const rest = (stage: Stage, status: CardStatus, needsAttentionReason: string | null = null): CardState => ({ stage, status, needsAttentionReason });
const queue = (stage: AgentStage, feedback?: string): Transition => ({
	next: rest(stage, "queued"),
	effects: [{ type: "start_run", stage, ...(feedback ? { feedback } : {}) }],
});

/**
 * The card lifecycle. Pure: no IO, no clock. The daemon's orchestrator is the only caller and the only executor
 * of the returned effects. Throws InvalidTransition for events that make no sense in the current state.
 */
export function transition(card: CardState, event: CardEvent): Transition {
	const { stage, status } = card;
	switch (event.type) {
		case "enqueue":
			if (stage === "backlog" && status === "idle") return queue("planning");
			break;

		case "run_started":
			if (status === "queued") return { next: rest(stage, "running"), effects: [] };
			break;

		case "run_settled": {
			if (status !== "running") break;
			if (event.result !== "pass") {
				const reason = event.result === "missing" ? event.summary : `${event.result}: ${event.summary}`;
				return { next: rest(stage, "needs_attention", reason), effects: [] };
			}
			if (stage === "planning") {
				return event.requiredGates.includes("plan_approval")
					? { next: rest("planning", "awaiting_gate"), effects: [{ type: "open_gate", kind: "plan_approval" }] }
					: queue("building");
			}
			// M3 sends a finished build on to testing. Until then it rests here.
			if (stage === "building") return { next: rest("building", "idle"), effects: [] };
			break;
		}

		case "run_failed":
			if (status === "running" || status === "queued") return { next: rest(stage, "needs_attention", event.error), effects: [] };
			break;

		case "run_aborted":
			if (status === "running" || status === "queued") return { next: rest(stage, "idle"), effects: [] };
			break;

		case "gate_decided":
			if (stage === "planning" && status === "awaiting_gate") {
				return event.decision === "approve" ? queue("building") : queue("planning", event.feedback);
			}
			break;

		case "retry":
			// Re-run the stage the card is stuck or resting in, optionally with guidance.
			if (isAgentStage(stage) && (status === "needs_attention" || status === "idle")) return queue(stage, event.feedback);
			break;
	}
	throw new InvalidTransition(card, event);
}
