import { STAGE_SPECS } from "./stage-spec.ts";
import type { AgentStage, StageConfigOverrides, StageModelConfig } from "./types.ts";

/** Resolves a stage's model config. Precedence: card > project > global > stage default. */
export function resolveStageConfig(
	stage: AgentStage,
	layers: { card?: StageConfigOverrides; project?: StageConfigOverrides; global?: StageConfigOverrides },
): StageModelConfig {
	return {
		...STAGE_SPECS[stage].defaults,
		...layers.global?.[stage],
		...layers.project?.[stage],
		...layers.card?.[stage],
	};
}
