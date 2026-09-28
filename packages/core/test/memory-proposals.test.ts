import { describe, expect, it } from "vitest";
import {
	applyProposal,
	emptyGraph,
	emptyProposals,
	parseLearnReport,
	seedFromMarkdown,
	validateProposalsFile,
	type GraphProposal,
	type LearnReportContext,
} from "../src/index.ts";

const ctx: LearnReportContext = { projectId: "todo-app", cardId: "card-7", commit: "abc123", now: 1_700_000_000_000 };

const gotchaReport = {
	proposals: [
		{
			action: "add_node",
			kind: "gotcha",
			name: "Empty titles pass validation",
			summary: "createTodo accepts an empty title and stores it.",
			source: "src/store.ts:14",
			evidence: "test output: addTodo(\"\") leaves the list length unchanged but the store gains an entry",
		},
		{
			action: "add_edge",
			edgeKind: "depends_on",
			from: "domain:api",
			to: "domain:storage",
			evidence: "src/routes.ts:9 imports the store directly",
		},
	],
};

describe("parseLearnReport", () => {
	it("turns a learn report into pending proposals with normalized ids", () => {
		const proposals = parseLearnReport(gotchaReport, ctx);
		expect(proposals).toHaveLength(2);
		const [node, edge] = proposals;
		expect(node!.status).toBe("pending");
		expect(node!.id).toBe("prop-card-7-0");
		expect(node!.node?.id).toBe("gotcha:empty-titles-pass-validation");
		expect(node!.node?.provenance).toMatchObject({ cardId: "card-7", commit: "abc123", confidence: 0.6 });
		expect(edge!.edge?.id).toBe("edge:depends_on:domain:api:domain:storage");
	});

	it("skips malformed entries but keeps the valid ones", () => {
		const proposals = parseLearnReport(
			{
				proposals: [
					{ action: "add_node", kind: "gotcha", name: "Good", summary: "s", source: "f:1", evidence: "e" },
					{ action: "add_node", kind: "widget", name: "Bad kind", summary: "s", source: "f:1", evidence: "e" },
					{ action: "add_node", kind: "gotcha", name: "No evidence", summary: "s", source: "f:1" },
					{ action: "retire_edge", edgeKind: "depends_on", from: "a" },
					"not an object",
				],
			},
			ctx,
		);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]!.node?.name).toBe("Good");
	});

	it("returns nothing for non-report shapes", () => {
		expect(parseLearnReport(null, ctx)).toEqual([]);
		expect(parseLearnReport({}, ctx)).toEqual([]);
		expect(parseLearnReport({ proposals: "nope" }, ctx)).toEqual([]);
	});

	it("matches seeded node ids so learned updates land on seed nodes", () => {
		const graph = seedFromMarkdown("# System model\n\n## Domains\n\n- **API** — the routes (`src/routes.ts`).\n", "todo-app", ctx);
		const proposals = parseLearnReport(
			{ proposals: [{ action: "update_node", kind: "domain", name: "API", summary: "Now also serves export.", evidence: "src/routes.ts:31" }] },
			ctx,
		);
		expect(graph.nodes.some((n) => n.id === proposals[0]!.node!.id)).toBe(true);
	});
});

describe("applyProposal", () => {
	const graphWith = () =>
		seedFromMarkdown(
			"# System model\n\n## Domains\n\n- **API** — the routes (`src/routes.ts`).\n- **Storage** — the store.\n\n## Invariants as built\n\n- **INV-1** — titles are non-empty (`src/store.ts:5`).\n",
			"todo-app",
			ctx,
		);

	it("add_node appends with the card's provenance", () => {
		const graph = graphWith();
		const proposal = parseLearnReport(gotchaReport, ctx)[0]!;
		const result = applyProposal(graph, proposal, ctx.now + 1);
		expect(result.applied).toBe(true);
		expect(result.graph.nodes).toHaveLength(graph.nodes.length + 1);
		expect(result.graph.nodes.at(-1)!.provenance.cardId).toBe("card-7");
	});

	it("skips an add_node that already exists", () => {
		const graph = graphWith();
		const proposal = parseLearnReport(
			{ proposals: [{ action: "add_node", kind: "domain", name: "API", summary: "Duplicate", source: "x:1", evidence: "e" }] },
			ctx,
		)[0]!;
		const result = applyProposal(graph, proposal, ctx.now);
		expect(result.applied).toBe(false);
		expect(result.graph.nodes).toHaveLength(graph.nodes.length);
	});

	it("update_node merges and bumps confidence with fresh provenance", () => {
		const graph = graphWith();
		const before = graph.nodes.find((n) => n.id === "invariant:inv-1")!;
		const proposal = parseLearnReport(
			{ proposals: [{ action: "update_node", kind: "invariant", name: "INV-1", summary: "Enforced at the store, not the route.", evidence: "src/store.ts:5" }] },
			ctx,
		)[0]!;
		const result = applyProposal(graph, proposal, ctx.now + 5);
		expect(result.applied).toBe(true);
		const after = result.graph.nodes.find((n) => n.id === "invariant:inv-1")!;
		expect(after.summary).toBe("Enforced at the store, not the route.");
		expect(after.provenance.confidence).toBeGreaterThan(before.provenance.confidence);
		expect(after.provenance.cardId).toBe("card-7");
	});

	it("update_node on a missing node is not applied", () => {
		const graph = graphWith();
		const proposal = parseLearnReport(
			{ proposals: [{ action: "update_node", kind: "gotcha", name: "Ghost", summary: "s", evidence: "e" }] },
			ctx,
		)[0]!;
		const result = applyProposal(graph, proposal, ctx.now);
		expect(result.applied).toBe(false);
	});

	it("retire_node removes the node and its incident edges", () => {
		const graph = graphWith();
		const withEdge = applyProposal(
			graph,
			parseLearnReport(gotchaReport, ctx)[1]!,
			ctx.now,
		).graph;
		expect(withEdge.edges).toHaveLength(1);
		const retire = parseLearnReport({ proposals: [{ action: "retire_node", kind: "domain", name: "API", evidence: "routes gone in refactor" }] }, ctx)[0]!;
		const result = applyProposal(withEdge, retire, ctx.now);
		expect(result.applied).toBe(true);
		expect(result.graph.nodes.some((n) => n.id === "domain:api")).toBe(false);
		expect(result.graph.edges).toHaveLength(0);
	});

	it("add_edge requires both endpoints and skips duplicates", () => {
		const graph = graphWith();
		const missing = parseLearnReport({ proposals: [{ action: "add_edge", edgeKind: "depends_on", from: "domain:api", to: "domain:ghost", evidence: "e" }] }, ctx)[0]!;
		expect(applyProposal(graph, missing, ctx.now).applied).toBe(false);
		const add = parseLearnReport(gotchaReport, ctx)[1]!;
		const once = applyProposal(graph, add, ctx.now);
		expect(once.applied).toBe(true);
		expect(applyProposal(once.graph, add, ctx.now).applied).toBe(false);
	});

	it("retire_edge removes the matching edge only", () => {
		const graph = graphWith();
		const withEdge = applyProposal(graph, parseLearnReport(gotchaReport, ctx)[1]!, ctx.now).graph;
		const retire = parseLearnReport({ proposals: [{ action: "retire_edge", edgeKind: "depends_on", from: "domain:api", to: "domain:storage", evidence: "store moved behind a port" }] }, ctx)[0]!;
		const result = applyProposal(withEdge, retire, ctx.now);
		expect(result.applied).toBe(true);
		expect(result.graph.edges).toHaveLength(0);
	});
});

describe("proposals file", () => {
	it("validates shape and round-trips", () => {
		const file = { ...emptyProposals("todo-app"), proposals: parseLearnReport(gotchaReport, ctx) };
		expect(validateProposalsFile(file)).toBe(true);
		expect(validateProposalsFile({ version: 99, projectId: "todo-app", proposals: [] })).toBe(false);
		expect(validateProposalsFile({ version: 1, projectId: "todo-app", proposals: [{ id: 1 }] })).toBe(false);
	});
});
