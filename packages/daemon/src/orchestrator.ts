import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Card, type CardEvent, type Effect, type GateKind, requiredGates, transition } from "@traffic-control/core";
import { type Config, paths } from "./config.ts";
import type { Db } from "./db/open.ts";
import { getCard, updateCard } from "./db/repo-cards.ts";
import { decideGate, getGate, insertGate } from "./db/repo-gates.ts";
import type { Bus } from "./events/bus.ts";
import type { RunOutcome, StageRunner } from "./stage-runner.ts";

export interface OrchestratorDeps {
	config: Config;
	db: Db;
	bus: Bus;
	stages: StageRunner;
}

/** The request is well-formed but conflicts with the card's current state. */
export class ConflictError extends Error {}

/** The only caller of core.transition() and the only executor of its effects. */
export class Orchestrator {
	private readonly deps: OrchestratorDeps;
	private readonly pending = new Set<Promise<void>>();

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
	}

	/** Applies an event to a card: persist the next state, publish it, then carry out the effects. Throws InvalidTransition. */
	dispatch(cardId: string, event: CardEvent): Card {
		const { db, bus } = this.deps;
		const card = getCard(db, cardId);
		if (!card) throw new Error(`Card not found: ${cardId}`);
		const { next, effects } = transition(card, event);
		const updated = updateCard(db, cardId, next);
		bus.publish({ topic: "board", type: "card_upserted", data: updated });
		for (const effect of effects) this.execute(cardId, effect);
		return updated;
	}

	decideGate(cardId: string, gateId: string, decision: "approve" | "reject", feedback: string): Card {
		const gate = getGate(this.deps.db, gateId);
		if (!gate || gate.cardId !== cardId) throw new Error(`Gate not found: ${gateId}`);
		if (gate.status !== "pending") throw new ConflictError("This gate has already been decided");
		// Transition first: if it is invalid nothing is recorded.
		const card = this.dispatch(cardId, { type: "gate_decided", decision, feedback });
		decideGate(this.deps.db, gateId, decision === "approve" ? "approved" : "rejected", feedback || null);
		this.deps.bus.publish({ topic: "board", type: "gate_decided", data: { cardId, gateId, decision } });
		return card;
	}

	handleStarted(cardId: string): void {
		this.dispatch(cardId, { type: "run_started" });
	}

	handleOutcome(cardId: string, outcome: RunOutcome): void {
		if (outcome.kind === "failed") this.dispatch(cardId, { type: "run_failed", error: outcome.error });
		else if (outcome.kind === "aborted") this.dispatch(cardId, { type: "run_aborted" });
		else {
			const gates = outcome.stage === "planning" && outcome.result === "pass" ? this.gatesFor(cardId) : [];
			this.dispatch(cardId, { type: "run_settled", result: outcome.result, summary: outcome.summary, requiredGates: gates });
		}
	}

	/** Resolves when no effect is being carried out and no stage is running. For tests and shutdown. */
	async whenIdle(): Promise<void> {
		const { stages } = this.deps;
		while (this.pending.size > 0 || stages.inFlight.size > 0) {
			await Promise.allSettled([...this.pending, ...stages.inFlight.values()]);
		}
	}

	private gatesFor(cardId: string): GateKind[] {
		const card = getCard(this.deps.db, cardId) as Card;
		const planFile = join(paths.cardDir(this.deps.config, cardId), "plan.md");
		const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : "";
		return requiredGates({
			card: { title: card.title, brief: card.brief, planningAttempt: card.attempt },
			plan: { bytes: Buffer.byteLength(plan), lines: plan.split("\n").length },
		});
	}

	private execute(cardId: string, effect: Effect): void {
		if (effect.type === "open_gate") {
			const gate = { id: randomUUID().slice(0, 8), cardId, kind: effect.kind, createdAt: Date.now() };
			insertGate(this.deps.db, gate);
			this.deps.bus.publish({ topic: "board", type: "gate_opened", data: gate });
			return;
		}
		// M4 puts the scheduler between "queued" and this call; until then a queued card starts immediately.
		const work = this.deps.stages
			.start(cardId, effect.stage, effect.feedback ? { feedback: effect.feedback } : {})
			.then(() => {})
			.catch((error) => void this.dispatch(cardId, { type: "run_failed", error: error instanceof Error ? error.message : String(error) }))
			.finally(() => this.pending.delete(work));
		this.pending.add(work);
	}
}
