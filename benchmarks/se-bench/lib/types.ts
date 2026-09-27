/** Shared result shapes for the three arms. */

export interface Usage {
	promptTokens: number;
	outputTokens: number;
	llmCalls: number;
	wallMs: number;
	/** Tower's summed session tokens (its own accounting), when the arm is tower. */
	towerTokens?: number;
}

export interface TowerMeta {
	cardId: string;
	projectId: string;
	endStage: string;
	endStatus: string;
	gatesDecided: string[];
	answers: number;
	retries: number;
	attention: string[];
}

export interface ArmResult {
	outDir: string;
	usage: Usage;
	notes: string[];
	tower?: TowerMeta;
}
