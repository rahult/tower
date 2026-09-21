import type { AgentStage, RunKind, StageModelConfig } from "../types.ts";
import type { StageResult } from "../stage-result.ts";

export interface PickModelContext {
	stage: AgentStage;
	/** 1 for the first run of a stage, 2+ after a failure sent the card back. */
	attempt: number;
	kind: RunKind;
	/** Already merged: card > project > global > stage default. */
	config: StageModelConfig;
	/** Why the previous attempt failed, when there was one. */
	lastResult?: StageResult;
}

/**
 * Decides which model runs a stage.
 *
 * Naive default: always the configured model. The interesting question is attempt 2+: retry the same cheap
 * model (near-free, may loop), escalate to a stronger one (breaks loops, costs more), or escalate only when
 * the same failure repeats. Revisited in M6.
 */
export function pickModel(ctx: PickModelContext): StageModelConfig {
	return ctx.config;
}
