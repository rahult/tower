import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentStage, resolveStageConfig, type StageConfigOverrides, type StageModelConfig, type ThinkingLevel } from "@tower/core";

const STAGES: AgentStage[] = ["planning", "building", "testing"];
const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The settings a person wrote are wrong in a way they can fix. */
export class SettingsError extends Error {}

export const settingsFile = (home: string) => join(home, "config.json");

/**
 * Validates the `models` part of config.json: which model runs each stage. A stage set to null (or left out)
 * uses Tower's default. Model names are pi's `provider/model-id` selectors.
 */
export function parseModels(input: unknown): StageConfigOverrides {
	if (input === undefined) return {};
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new SettingsError('"models" must be an object keyed by stage: planning, building, testing');
	const models: StageConfigOverrides = {};
	for (const [stage, value] of Object.entries(input)) {
		if (!STAGES.includes(stage as AgentStage)) throw new SettingsError(`Unknown stage "${stage}". Stages with a model are: ${STAGES.join(", ")}`);
		if (value === null || value === undefined) continue;
		const { model, thinking } = value as { model?: unknown; thinking?: unknown };
		const entry: Partial<StageModelConfig> = {};
		if (model !== undefined && model !== "") {
			if (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model)) throw new SettingsError(`${stage}: "${String(model)}" is not a provider/model name such as zai/glm-5.3 (see: pi --list-models)`);
			entry.model = model;
		}
		if (thinking !== undefined && thinking !== "") {
			if (!THINKING.includes(thinking as ThinkingLevel)) throw new SettingsError(`${stage}: thinking must be one of ${THINKING.join(", ")}`);
			entry.thinking = thinking as ThinkingLevel;
		}
		if (Object.keys(entry).length > 0) models[stage as AgentStage] = entry;
	}
	return models;
}

/** Reads ~/.tower/config.json. A missing file means defaults; a broken one stops the daemon with the reason. */
export function readModels(home: string): StageConfigOverrides {
	const file = settingsFile(home);
	if (!existsSync(file)) return {};
	try {
		return parseModels((JSON.parse(readFileSync(file, "utf8")) as { models?: unknown }).models);
	} catch (error) {
		throw new Error(`Cannot use ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Saves the models, keeping any other keys a person has put in the file. */
export function writeModels(home: string, models: StageConfigOverrides): void {
	const file = settingsFile(home);
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(file)) existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		// An unreadable file is replaced by a valid one.
	}
	mkdirSync(home, { recursive: true });
	writeFileSync(file, `${JSON.stringify({ ...existing, models }, null, 2)}\n`);
}

/** What each stage will actually run with, and whether that came from config.json or Tower's defaults. */
export function describeModels(models: StageConfigOverrides): Record<AgentStage, StageModelConfig & { source: "config" | "default" }> {
	return Object.fromEntries(STAGES.map((stage) => [stage, { ...resolveStageConfig(stage, { global: models }), source: models[stage] ? "config" : "default" }])) as Record<
		AgentStage,
		StageModelConfig & { source: "config" | "default" }
	>;
}

/** Model names pi knows about, for suggestions in the settings form. Empty when pi's catalog cannot be read. */
export function knownModels(env: NodeJS.ProcessEnv = process.env): string[] {
	const dir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const names = new Set<string>();
	const collect = (file: string, pick: (json: any) => Record<string, { models?: Array<{ id?: string }> }>) => {
		try {
			for (const [provider, entry] of Object.entries(pick(JSON.parse(readFileSync(join(dir, file), "utf8"))))) {
				for (const model of entry.models ?? []) if (model.id) names.add(`${provider}/${model.id}`);
			}
		} catch {
			// No catalog, no suggestions.
		}
	};
	collect("models-store.json", (json) => json);
	collect("models.json", (json) => json.providers ?? {});
	return [...names].sort();
}
