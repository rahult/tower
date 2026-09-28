import {
	emptyGraph,
	type GraphQuery,
	type MemoryEdge,
	type MemoryGraph,
	type MemoryNode,
	type NodeKind,
	type Provenance,
	type Subgraph,
} from "./memory-graph.ts";

const slug = (kind: string, name: string): string =>
	`${kind}:${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/** BFS from seeds, capped at depth. Pure. */
export const relevantSubgraph = (graph: MemoryGraph, query: GraphQuery): Subgraph => {
	const depth = Math.max(0, query.depth);
	const seeds = new Set(query.seedNodeIds.filter((id) => graph.nodes.some((n) => n.id === id)));
	if (seeds.size === 0) return { nodes: [], edges: [] };

	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const adj: Array<[string, string]> = [];
	for (const e of graph.edges) {
		adj.push([e.from, e.to], [e.to, e.from]);
	}

	const reached = new Map<string, number>();
	const queue: Array<{ id: string; d: number }> = [];
	for (const id of seeds) {
		reached.set(id, 0);
		queue.push({ id, d: 0 });
	}
	while (queue.length > 0) {
		const { id, d } = queue.shift()!;
		if (d >= depth) continue;
		for (const [a, b] of adj) {
			if (a !== id || reached.has(b)) continue;
			reached.set(b, d + 1);
			queue.push({ id: b, d: d + 1 });
		}
	}

	const nodes = graph.nodes.filter((n) => reached.has(n.id));
	const ids = new Set(nodes.map((n) => n.id));
	const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
	return { nodes, edges };
};

/** Bump lastTouched on the given nodes. Pure. */
export const touch = (graph: MemoryGraph, nodeIds: string[], at: number): MemoryGraph => {
	const set = new Set(nodeIds);
	return {
		...graph,
		nodes: graph.nodes.map((n) =>
			set.has(n.id) ? { ...n, provenance: { ...n.provenance, lastTouched: at } } : n,
		),
	};
};

/** Node ids whose lastTouched is older than `untouchedForMs`. Pure. */
export const markCooling = (graph: MemoryGraph, now: number, untouchedForMs: number): string[] =>
	graph.nodes.filter((n) => now - n.provenance.lastTouched >= untouchedForMs).map((n) => n.id);

const headingKind: Record<string, NodeKind> = {
	domains: "domain",
	domain: "domain",
	actors: "actor",
	actor: "actor",
	flows: "flow",
	flow: "flow",
	"state and transitions": "entity",
	state: "entity",
	entities: "entity",
	invariants as built: "invariant",
	invariants: "invariant",
	risks and quirks: "gotcha",
	risks: "gotcha",
	gotchas: "gotcha",
};

/**
 * Best-effort parse of an existing system-model.md into nodes.
 * Idempotent on (kind, name). Confidence starts low so the first real card raises it.
 */
export const seedFromMarkdown = (
	markdown: string,
	projectId: string,
	meta: { cardId: string; commit: string; now: number },
	existing?: MemoryGraph | null,
): MemoryGraph => {
	const graph = existing && existing.projectId === projectId ? structuredClone(existing) : emptyGraph(projectId);
	const byKey = new Map(graph.nodes.map((n) => [`${n.kind}:${n.name.toLowerCase()}`, n]));
	const provenance: Provenance = {
		cardId: meta.cardId,
		commit: meta.commit,
		confidence: 0.4,
		lastTouched: meta.now,
	};

	let current: NodeKind | null = null;
	for (const raw of markdown.split(/\r?\n/)) {
		const heading = raw.match(/^#{1,3}\s+(.+?)\s*$/);
		if (heading) {
			const key = heading[1].trim().toLowerCase().replace(/[:.]+$/, "");
			current = headingKind[key] ?? null;
			continue;
		}
		if (!current) continue;
		const item = raw.match(/^[-*]\s+\*\*(.+?)\*\*\s*[—–:\-]\s*(.+)$/) ?? raw.match(/^[-*]\s+(.+)$/);
		if (!item) continue;
		const name = (item[1] ?? "").replace(/\*+/g, "").trim();
		if (!name || name.length > 80) continue;
		const summary = (item[2] ?? name).trim();
		const sourceMatch = summary.match(/`([^`]+:\d+)`/);
		const key = `${current}:${name.toLowerCase()}`;
		if (byKey.has(key)) continue;
		const node: MemoryNode = {
			id: slug(current, name),
			kind: current,
			name,
			summary: summary.slice(0, 280),
			source: sourceMatch?.[1] ?? "seeded from system-model.md",
			provenance,
			details: {},
		};
		graph.nodes.push(node);
		byKey.set(key, node);
	}
	return graph;
};

const kindHeading: Record<NodeKind, string> = {
	domain: "Domains",
	actor: "Actors",
	flow: "Flows",
	entity: "State and transitions",
	invariant: "Invariants as built",
	gotcha: "Risks and quirks",
	failure_mode: "Failure modes",
};

/** Project the graph as the Markdown the planner already expects. */
export const renderSystemModel = (graph: MemoryGraph): string => {
	const lines: string[] = ["# System model", "", `_Generated from the project memory graph (${graph.nodes.length} nodes, ${graph.edges.length} edges)._`, ""];
	const order: NodeKind[] = ["domain", "actor", "flow", "entity", "invariant", "gotcha", "failure_mode"];
	for (const kind of order) {
		const nodes = graph.nodes.filter((n) => n.kind === kind);
		if (nodes.length === 0) continue;
		lines.push(`## ${kindHeading[kind]}`, "");
		for (const n of nodes) {
			const outgoing = graph.edges.filter((e) => e.from === n.id);
			const related = outgoing
				.map((e) => {
					const to = graph.nodes.find((x) => x.id === e.to);
					return to ? `${e.kind} ${to.name}` : null;
				})
				.filter(Boolean);
			const rel = related.length ? ` Related: ${related.join("; ")}.` : "";
			lines.push(`- **${n.name}** — ${n.summary} (\"${n.source}\")${rel}`);
		}
		lines.push("");
	}
	return `${lines.join("\n").trim()}\n`;
};

export const findSeedsByName = (graph: MemoryGraph, text: string): string[] => {
	const hay = text.toLowerCase();
	return graph.nodes.filter((n) => n.name.length >= 3 && hay.includes(n.name.toLowerCase())).map((n) => n.id);
};

export type { MemoryEdge };
