import { describe, expect, it } from "vitest";
import {
	emptyGraph,
	isEmpty,
	MEMORY_GRAPH_VERSION,
	type MemoryGraph,
	validateGraph,
} from "../src/memory-graph.ts";
import { findSeedsByName, markCooling, relevantSubgraph, renderSystemModel, seedFromMarkdown, touch } from "../src/memory-graph-ops.ts";

const prov = (n = 1) => ({ cardId: "c1", commit: "deadbeef", confidence: 0.6, lastTouched: n });

const sample = (): MemoryGraph => ({
	version: MEMORY_GRAPH_VERSION,
	projectId: "p",
	nodes: [
		{ id: "d1", kind: "domain", name: "billing", summary: "charges", source: "a.ts:1", provenance: prov(), details: {} },
		{ id: "d2", kind: "domain", name: "auth", summary: "identity", source: "b.ts:1", provenance: prov(), details: {} },
		{ id: "a1", kind: "actor", name: "checkout", summary: "pays", source: "c.ts:1", provenance: prov(), details: {} },
	],
	edges: [
		{ id: "e1", kind: "acts_on", from: "a1", to: "d1", provenance: prov(), details: {} },
		{ id: "e2", kind: "depends_on", from: "d1", to: "d2", provenance: prov(), details: {} },
	],
});

describe("validateGraph", () => {
	it("accepts emptyGraph", () => {
		const g = emptyGraph("proj-1");
		expect(g.version).toBe(MEMORY_GRAPH_VERSION);
		expect(isEmpty(g)).toBe(true);
		expect(validateGraph(g)).toBe(true);
	});

	it("rejects unknown version and kinds", () => {
		expect(validateGraph({ ...emptyGraph("p"), version: 99 })).toBe(false);
		const bad = structuredClone(sample());
		(bad.nodes[0] as { kind: string }).kind = "widget";
		expect(validateGraph(bad)).toBe(false);
	});

	it("rejects dangling edges and bad confidence", () => {
		const dangling = structuredClone(sample());
		dangling.edges[0].to = "missing";
		expect(validateGraph(dangling)).toBe(false);
		const conf = structuredClone(sample());
		conf.nodes[0].provenance.confidence = 1.5;
		expect(validateGraph(conf)).toBe(false);
	});
});

describe("relevantSubgraph", () => {
	it("caps hop depth", () => {
		const g = sample();
		const one = relevantSubgraph(g, { seedNodeIds: ["a1"], depth: 1 });
		expect(one.nodes.map((n) => n.id).sort()).toEqual(["a1", "d1"]);
		const two = relevantSubgraph(g, { seedNodeIds: ["a1"], depth: 2 });
		expect(two.nodes.map((n) => n.id).sort()).toEqual(["a1", "d1", "d2"]);
	});

	it("returns empty when seeds miss", () => {
		expect(relevantSubgraph(sample(), { seedNodeIds: ["nope"], depth: 2 }).nodes).toEqual([]);
	});
});

describe("touch and cooling", () => {
	it("bumps lastTouched only on named nodes", () => {
		const next = touch(sample(), ["d1"], 99);
		expect(next.nodes.find((n) => n.id === "d1")?.provenance.lastTouched).toBe(99);
		expect(next.nodes.find((n) => n.id === "d2")?.provenance.lastTouched).toBe(1);
	});

	it("marks cooling past the threshold", () => {
		expect(markCooling(sample(), 100, 50)).toEqual(["d1", "d2", "a1"]);
		expect(markCooling(sample(), 10, 50)).toEqual([]);
	});
});

describe("seedFromMarkdown", () => {
	const md = `# Model\n\n## Domains\n\n- **Billing** — charges live in \`server/billing.ts:12\`\n- **Auth** — sessions\n\n## Actors\n\n- **Checkout service** — talks to billing\n`;
	it("seeds nodes idempotently", () => {
		const first = seedFromMarkdown(md, "p", { cardId: "c", commit: "abc", now: 1 });
		expect(first.nodes.some((n) => n.kind === "domain" && n.name === "Billing")).toBe(true);
		const second = seedFromMarkdown(md, "p", { cardId: "c2", commit: "def", now: 2 }, first);
		expect(second.nodes.length).toBe(first.nodes.length);
	});
});

describe("render and seeds", () => {
	it("renders expected headings", () => {
		const md = renderSystemModel(sample());
		expect(md).toContain("## Domains");
		expect(md).toContain("## Actors");
		expect(md).toContain("**billing**");
	});

	it("finds seeds mentioned in a brief", () => {
		expect(findSeedsByName(sample(), "Add retry to billing checkout")).toEqual(expect.arrayContaining(["d1", "a1"]));
	});
});
