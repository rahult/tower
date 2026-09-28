import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	emptyGraph,
	renderSystemModel,
	seedFromMarkdown,
	validateGraph,
	type MemoryGraph,
} from "@tower/core";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";

export const memoryGraphPath = (config: Config, projectId: string): string =>
	join(paths.projectDir(config, projectId), "memory-graph.json");

export const readGraph = (config: Config, projectId: string): MemoryGraph | null => {
	const file = memoryGraphPath(config, projectId);
	if (!existsSync(file)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return validateGraph(parsed) ? parsed : null;
	} catch {
		return null;
	}
};

/** Atomic write: temp file then rename so a crash cannot leave a half-written graph. */
export const writeGraph = (config: Config, projectId: string, graph: MemoryGraph): void => {
	if (!validateGraph(graph)) throw new Error("refusing to write an invalid memory graph");
	const file = memoryGraphPath(config, projectId);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(graph, null, 2)}\n`);
	renameSync(tmp, file);
};

/**
 * After an understand run is promoted, seed the graph from the Markdown if none exists yet.
 * Idempotent: a second promote does not duplicate nodes.
 */
export const seedGraphFromModel = (options: {
	config: Config;
	projectId: string;
	cardId: string;
	commit: string;
}): MemoryGraph => {
	const { config, projectId, cardId, commit } = options;
	const markdownPath = paths.systemModel(config, projectId);
	const markdown = existsSync(markdownPath) ? readFileSync(markdownPath, "utf8") : "";
	const existing = readGraph(config, projectId);
	const graph = seedFromMarkdown(markdown, projectId, { cardId, commit, now: Date.now() }, existing);
	writeGraph(config, projectId, graph);
	return graph;
};

export const writeProjectedModel = (config: Config, projectId: string, graph: MemoryGraph): void => {
	const model = paths.systemModel(config, projectId);
	mkdirSync(dirname(model), { recursive: true });
	writeFileSync(model, renderSystemModel(graph));
};

export { emptyGraph, renderSystemModel, seedFromMarkdown };
