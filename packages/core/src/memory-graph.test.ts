import { describe, expect, it } from "vitest";
import {
	emptyGraph,
	isEmpty,
	MEMORY_GRAPH_VERSION,
	type MemoryGraph,
	validateGraph,
} from "./memory-graph.ts";

describe("memory graph", () => {
	it("emptyGraph is valid and empty", () => {
		const g = emptyGraph("proj-1");
		expect(g.version).toBe(MEMORY_GRAPH_VERSION);
		expect(g.projectId).toBe("proj-1");
		expect(isEmpty(g)).toBe(true);
		expect(validateGraph(g)).toBe(true);
	});

	it("rejects an unknown version", () => {
		const bad = { ...emptyGraph("p"), version: 99 };
		expect(validateGraph(bad)).toBe(false);
	});

	it("rejects an unknown node kind", () => {
		const bad = {
			...emptyGraph("p"),
			nodes: [
				{
					id: "n1",
					kind: "widget",
					name: "x",
					summary: "y",
					source: "z",
					provenance: {
						cardId: "c",
						commit: "abc",
						confidence: 0.5,
						lastTouched: 1,
					},
					details: {},
				},
			],
		} as unknown as MemoryGraph;
		expect(validateGraph(bad)).toBe(false);
	});

	it("rejects an edge whose endpoint is missing", () => {
		const bad = {
			...emptyGraph("p"),
			nodes: [
				{
					id: "n1",
					kind: "domain",
					name: "billing",
					summary: "s",
					source: "f:1",
					provenance: { cardId: "c", commit: "a", confidence: 0.5, lastTouched: 1 },
					details: {},
				},
			],
			edges: [
				{
					id: "e1",
					kind: "depends_on",
					from: "n1",
					to: "missing",
					provenance: { cardId: "c", commit: "a", confidence: 0.5, lastTouched: 1 },
					details: {},
				},
			],
		} as MemoryGraph;
		expect(validateGraph(bad)).toBe(false);
	});

	it("rejects a confidence outside 0..1", () => {
		const bad = {
			...emptyGraph("p"),
			nodes: [
				{
					id: "n1",
					kind: "domain",
					name: "billing",
					summary: "s",
					source: "f:1",
					provenance: { cardId: "c", commit: "a", confidence: 1.5, lastTouched: 1 },
					details: {},
				},
			],
		} as MemoryGraph;
		expect(validateGraph(bad)).toBe(false);
	});

	it("accepts a well-formed graph with nodes and edges", () => {
		const now = Date.now();
		const prov = { cardId: "c1", commit: "deadbeef", confidence: 0.6, lastTouched: now };
		const good: MemoryGraph = {
			version: MEMORY_GRAPH_VERSION,
			projectId: "p",
			nodes: [
				{ id: "d1", kind: "domain", name: "billing", summary: "s", source: "f:1", provenance: prov, details: {} },
				{ id: "a1", kind: "actor", name: "checkout-service", summary: "s", source: "f:2", provenance: prov, details: {} },
			],
			edges: [{ id: "e1", kind: "acts_on", from: "a1", to: "d1", provenance: prov, details: {} }],
		};
		expect(validateGraph(good)).toBe(true);
		expect(isEmpty(good)).toBe(false);
	});
});
