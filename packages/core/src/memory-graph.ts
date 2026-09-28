/**
 * Project-scoped memory graph: the living knowledge a project's cards read from
 * and write to. Replaces the one-shot system-model.md snapshot for opted-in
 * projects; the Markdown the planner reads is a generated projection of this.
 *
 * Spec: docs/superpowers/specs/2026-09-28-project-memory-graph.md
 */

export const MEMORY_GRAPH_VERSION = 1 as const;

export type NodeKind =
	| "domain"
	| "actor"
	| "flow"
	| "entity"
	| "invariant"
	| "gotcha"
	| "failure_mode";

export type EdgeKind =
	| "acts_on"
	| "reads"
	| "writes"
	| "depends_on"
	| "enforces"
	| "has_gotcha"
	| "fails_at";

/** Where a node or edge came from and how much to trust it. */
export interface Provenance {
	/** The card that discovered or last confirmed this. */	cardId: string;
	/** The repository commit the discovery was grounded in. */	commit: string;
	/** 0..1. Starts low on seed, rises with confirms, falls on contradiction. */	confidence: number;
	/** Epoch ms of the last read or write that touched this node/edge. */	lastTouched: number;
}

export interface MemoryNode {
	id: string;
	kind: NodeKind;
	/** Short display name, unique within (projectId, kind). */	name: string;
	/** One-line summary a planner can scan. */	summary: string;
	/** Grounding: file:line or "not enforced — only intended". */	source: string;
	provenance: Provenance;
	/** Kind-specific payload; kept loose so new kinds don't churn the type. */	details: Record<string, unknown>;
}

export interface MemoryEdge {
	id: string;
	kind: EdgeKind;
	from: string;
	to: string;
	provenance: Provenance;
	details: Record<string, unknown>;
}

export interface MemoryGraph {
	version: typeof MEMORY_GRAPH_VERSION;
	projectId: string;
	nodes: MemoryNode[];
	edges: MemoryEdge[];
}

/** What a planner or builder asks for before starting work. */
export interface GraphQuery {
	/** Node ids the card's brief is known to touch. */	seedNodeIds: string[];
	/** Hop depth from each seed; 1 = direct neighbours only. */	depth: number;
}

export interface Subgraph {
	nodes: MemoryNode[];
	edges: MemoryEdge[];
}

/** True when the graph has no nodes — a fresh project or a failed seed. */
export const isEmpty = (graph: MemoryGraph): boolean => graph.nodes.length === 0;

/**
 * Validate a parsed graph. Rejects unknown versions and unknown kinds rather
 * than coercing — a corrupt graph must surface, not silently mislead agents.
 */
export const validateGraph = (value: unknown): value is MemoryGraph => {
	if (value === null || typeof value !== "object") return false;
	const g = value as Partial<MemoryGraph>;
	if (g.version !== MEMORY_GRAPH_VERSION) return false;
	if (typeof g.projectId !== "string") return false;
	if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return false;
	const nodeIds = new Set<string>();
	for (const n of g.nodes) {
		if (n === null || typeof n !== "object") return false;
		if (typeof n.id !== "string" || nodeIds.has(n.id)) return false;
		nodeIds.add(n.id);
		if (!isNodeKind(n.kind)) return false;
		if (typeof n.name !== "string" || typeof n.summary !== "string") return false;
		if (typeof n.source !== "string") return false;
		if (!isProvenance(n.provenance)) return false;
	}
	for (const e of g.edges) {
		if (e === null || typeof e !== "object") return false;
		if (typeof e.id !== "string") return false;
		if (!isEdgeKind(e.kind)) return false;
		if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) return false;
		if (!isProvenance(e.provenance)) return false;
	}
	return true;
};

const isNodeKind = (k: unknown): k is NodeKind =>
	typeof k === "string" &&
	["domain", "actor", "flow", "entity", "invariant", "gotcha", "failure_mode"].includes(k);

const isEdgeKind = (k: unknown): k is EdgeKind =>
	typeof k === "string" &&
	["acts_on", "reads", "writes", "depends_on", "enforces", "has_gotcha", "fails_at"].includes(k);

const isProvenance = (p: unknown): p is Provenance => {
	if (p === null || typeof p !== "object") return false;
	const x = p as Partial<Provenance>;
	return (
		typeof x.cardId === "string" &&
		typeof x.commit === "string" &&
		typeof x.confidence === "number" &&
		x.confidence >= 0 &&
		x.confidence <= 1 &&
		typeof x.lastTouched === "number"
	);
};

/** Empty, versioned shell — used on first touch of a project. */
export const emptyGraph = (projectId: string): MemoryGraph => ({
	version: MEMORY_GRAPH_VERSION,
	projectId,
	nodes: [],
	edges: [],
});
