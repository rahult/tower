import type { AgentStage, StageModelConfig } from "./types.ts";

export interface StageSpec {
	stage: AgentStage;
	/** Short token used in session ids, e.g. c<card>-plan-1. */
	slug: string;
	/** File name under prompts/. */
	promptFile: string;
	/** pi built-in tools the stage may use. */
	tools: string[];
	/** Artifact the stage must produce in the card folder, if any. */
	artifact: string | null;
	defaults: StageModelConfig;
}

const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Expensive models plan, cheap models build. Overridable per project and per card via StageConfigOverrides. */
export const STAGE_SPECS: Record<AgentStage, StageSpec> = {
	planning: {
		stage: "planning",
		slug: "plan",
		promptFile: "planning.md",
		// write is needed for plan.md; the prompt forbids touching the worktree.
		tools: ["read", "bash", "write", "grep", "find", "ls"],
		artifact: "plan.md",
		defaults: { model: "anthropic/claude-fable-5-1", thinking: "high" },
	},
	building: {
		stage: "building",
		slug: "build",
		promptFile: "building.md",
		tools: ALL_TOOLS,
		artifact: null,
		defaults: { model: "zai/glm-5.3", thinking: "medium" },
	},
	testing: {
		stage: "testing",
		slug: "test",
		promptFile: "testing.md",
		tools: ALL_TOOLS,
		artifact: "test-report.md",
		defaults: { model: "zai/glm-5.3", thinking: "medium" },
	},
};

export const STAGE_RESULT_FILE = "stage-result.json";

export function sessionIdFor(cardId: string, stage: AgentStage, attempt: number): string {
	return `c${cardId}-${STAGE_SPECS[stage].slug}-${attempt}`;
}
