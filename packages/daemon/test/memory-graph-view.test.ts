import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyGraph, emptyProposals, type GraphProposal, type MemoryEdge, type MemoryGraph, type MemoryNode, type Provenance } from "@tower/core";
import { bootHarness, type FakeScript, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

// No card ever runs in these tests; the endpoint only reads what was seeded on disk.
const idle: FakeScript = () => [];

const prov = (cardId: string): Provenance => ({ cardId, commit: "abc123def0", confidence: 0.6, lastTouched: 1_700_000_000_000 });

const node = (id: string, kind: MemoryNode["kind"], name: string, summary: string, source: string): MemoryNode => ({
	id,
	kind,
	name,
	summary,
	source,
	provenance: prov("card-1"),
	details: {},
});

const edge = (id: string, kind: MemoryEdge["kind"], from: string, to: string): MemoryEdge => ({
	id,
	kind,
	from,
	to,
	provenance: prov("card-1"),
	details: {},
});

/** The graph the view renders: two domains, an actor, an invariant and a gotcha, linked by three edges. */
function seedGraph(projectId: string): MemoryGraph {
	const graph = emptyGraph(projectId);
	graph.nodes.push(
		node("domain:api", "domain", "API", "The HTTP routes.", "src/routes.ts:1"),
		node("domain:store", "domain", "Storage", "The in-memory store.", "src/store.ts:1"),
		node("actor:user", "actor", "User", "A person clicking through the app.", "not enforced — only intended"),
		node("invariant:inv-1", "invariant", "INV-1", "A todo's title is never empty.", "src/store.ts:3"),
		node("gotcha:toggle-in-place", "gotcha", "Toggle mutates in place", "toggle() edits the entry, so subscribers see the same object change.", "src/store.ts:9"),
	);
	graph.edges.push(
		edge("edge:reads:actor:user:domain:api", "reads", "actor:user", "domain:api"),
		edge("edge:depends_on:domain:api:domain:store", "depends_on", "domain:api", "domain:store"),
		edge("edge:has_gotcha:domain:store:gotcha:toggle-in-place", "has_gotcha", "domain:store", "gotcha:toggle-in-place"),
	);
	return graph;
}

const writeSeed = (projectId: string, graph: MemoryGraph, pending: number): void => {
	const dir = join(h.home, "projects", projectId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "memory-graph.json"), `${JSON.stringify(graph, null, 2)}\n`);
	const proposals = emptyProposals(projectId);
	for (let i = 0; i < pending + 1; i++) {
		const proposal: GraphProposal = {
			id: `prop-${i}`,
			projectId,
			cardId: "card-1",
			action: "add_node",
			node: node(`gotcha:pending-${i}`, "gotcha", `Pending ${i}`, "A learned gotcha.", "src/x.ts:1"),
			edge: null,
			evidence: "test output",
			status: i < pending ? "pending" : "accepted",
			createdAt: 1_700_000_000_000,
			decidedAt: i < pending ? null : 1_700_000_000_100,
		};
		proposals.proposals.push(proposal);
	}
	writeFileSync(join(dir, "memory-proposals.json"), `${JSON.stringify(proposals, null, 2)}\n`);
};

describe("the memory graph view", () => {
	it("serves the graph, the rendered system model and the pending count", async () => {
		h = await bootHarness(idle);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		writeSeed(project.id, seedGraph(project.id), 2);

		const res = await h.api("GET", `/api/projects/${project.id}/graph`);
		expect(res.status).toBe(200);
		const body = res.body as { graph: MemoryGraph; systemModel: string; pendingProposals: number };
		expect(body.graph.nodes.map((n) => n.id).sort()).toEqual(
			["actor:user", "domain:api", "domain:store", "gotcha:toggle-in-place", "invariant:inv-1"],
		);
		expect(body.graph.edges).toHaveLength(3);
		expect(body.systemModel.length).toBeGreaterThan(0);
		expect(body.systemModel).toContain("# System model");
		expect(body.systemModel).toContain("Toggle mutates in place");
		expect(body.systemModel).toContain("depends_on Storage");
		expect(body.pendingProposals).toBe(2);
	});

	it("returns graph:null for a project whose graph was never seeded", async () => {
		h = await bootHarness(idle);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const res = await h.api("GET", `/api/projects/${project.id}/graph`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ graph: null, systemModel: null, pendingProposals: 0 });
	});

	it("404s for a project the board does not know", async () => {
		h = await bootHarness(idle);
		const res = await h.api("GET", "/api/projects/nope/graph");
		expect(res.status).toBe(404);
	});
});
