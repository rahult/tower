/**
 * The write path of the memory graph: structured proposals a card's learn step files
 * after it finishes, pending human confirmation before they touch the graph.
 *
 * Spec: docs/superpowers/specs/2026-09-28-project-memory-graph.md (Phase 2)
 */

import {
	type EdgeKind,
	type MemoryEdge,
	type MemoryGraph,
	type MemoryNode,
	type NodeKind,
	type Provenance,
} from "./memory-graph.ts";
import { slug } from "./memory-graph-ops.ts";

export const PROPOSALS_FILE_VERSION = 1 as const;

export type ProposalAction = "add_node" | "update_node" | "retire_node" | "add_edge" | "retire_edge";
export type ProposalStatus = "pending" | "accepted" | "rejected";

/** One proposed change to the graph, with the evidence the card observed. */
export interface GraphProposal {
	id: string;
	projectId: string;
	cardId: string;
	action: ProposalAction;
	/** Target node for node actions (add: full node; update/retire: identity + merged fields). */
	node: MemoryNode | null;
	/** Target edge for edge actions. */
	edge: MemoryEdge | null;
	/** What the card saw: file:line, test output, a review finding. */
	evidence: string;
	status: ProposalStatus;
	createdAt: number;
	decidedAt: number | null;
}

export interface ProposalsFile {
	version: typeof PROPOSALS_FILE_VERSION;
	projectId: string;
	proposals: GraphProposal[];
}

/** The context a learn step stamps on every proposal it files. */
export interface LearnReportContext {
	projectId: string;
	cardId: string;
	commit: string;
	now: number;
}

/** The builder writes this next to shipped.md; it is a structured diff, not prose. */
interface LearnReportEntry {
	action: ProposalAction;
	kind?: NodeKind;
	name?: string;
	summary?: string;
	source?: string;
	edgeKind?: EdgeKind;
	from?: string;
	to?: string;
	evidence?: string;
}

const NODE_ACTIONS: ProposalAction[] = ["add_node", "update_node", "retire_node"];
const EDGE_ACTIONS: ProposalAction[] = ["add_edge", "retire_edge"];

const isNodeKind = (k: unknown): k is NodeKind =>
	typeof k === "string" &&
	["domain", "actor", "flow", "entity", "invariant", "gotcha", "failure_mode"].includes(k);

const isEdgeKind = (k: unknown): k is EdgeKind =>
	typeof k === "string" &&
	["acts_on", "reads", "writes", "depends_on", "enforces", "has_gotcha", "fails_at"].includes(k);

const isAction = (a: unknown): a is ProposalAction =>
	typeof a === "string" && [...NODE_ACTIONS, ...EDGE_ACTIONS].includes(a as ProposalAction);

const isValidEntry = (entry: LearnReportEntry): boolean => {
	if (!isAction(entry.action) || typeof entry.evidence !== "string" || entry.evidence.trim() === "") return false;
	if (NODE_ACTIONS.includes(entry.action)) {
		if (!isNodeKind(entry.kind) || typeof entry.name !== "string" || entry.name.trim() === "" || entry.name.length > 80) return false;
		// Adds carry the full node; updates and retirements need only the identity and evidence.
		if (entry.action === "add_node") {
			return typeof entry.summary === "string" && entry.summary.trim() !== "" && typeof entry.source === "string" && entry.source.trim() !== "";
		}
		return true;
	}
	return isEdgeKind(entry.edgeKind) && typeof entry.from === "string" && entry.from.trim() !== "" && typeof entry.to === "string" && entry.to.trim() !== "";
};

/**
 * Validate and normalize a learn report. Malformed entries are skipped, never stored —
 * a wrong entry would mislead every later card. Ids follow the seed slug rule so a
 * learned update lands on the node the seed created.
 */
export const parseLearnReport = (raw: unknown, ctx: LearnReportContext): GraphProposal[] => {
	if (raw === null || typeof raw !== "object") return [];
	const list = (raw as { proposals?: unknown }).proposals;
	if (!Array.isArray(list)) return [];
	const provenance: Provenance = { cardId: ctx.cardId, commit: ctx.commit, confidence: 0.6, lastTouched: ctx.now };

	return list.filter((e): e is LearnReportEntry => e !== null && typeof e === "object" && isValidEntry(e)).map((entry, index) => {
		const base = {
			id: `prop-${ctx.cardId}-${index}`,
			projectId: ctx.projectId,
			cardId: ctx.cardId,
			evidence: entry.evidence!.trim(),
			status: "pending" as const,
			createdAt: ctx.now,
			decidedAt: null,
		};
		if (EDGE_ACTIONS.includes(entry.action)) {
			const edge: MemoryEdge = {
				id: `edge:${entry.edgeKind}:${entry.from}:${entry.to}`,
				kind: entry.edgeKind!,
				from: entry.from!,
				to: entry.to!,
				provenance,
				details: {},
			};
			return { ...base, action: entry.action, node: null, edge };
		}
		const node: MemoryNode = {
			id: slug(entry.kind!, entry.name!),
			kind: entry.kind!,
			name: entry.name!.trim(),
			summary: (entry.summary ?? "").trim().slice(0, 280),
			source: (entry.source ?? "").trim(),
			provenance,
			details: {},
		};
		return { ...base, action: entry.action, node, edge: null };
	});
};

export interface ApplyResult {
	graph: MemoryGraph;
	applied: boolean;
	reason: string | null;
}

/**
 * Apply one decision to the graph. Pure; the caller writes the result back. The codebase
 * wins on conflict: an update to a missing node and an edge to a missing endpoint are
 * refused rather than invented.
 */
export const applyProposal = (graph: MemoryGraph, proposal: GraphProposal, now: number): ApplyResult => {
	const refuse = (reason: string): ApplyResult => ({ graph, applied: false, reason });
	const nodes = structuredClone(graph.nodes);
	const edges = structuredClone(graph.edges);
	const next: MemoryGraph = { ...graph, nodes, edges };

	if (proposal.action === "add_node") {
		const node = proposal.node!;
		if (nodes.some((n) => n.id === node.id)) return refuse(`node ${node.id} already exists`);
		nodes.push({ ...structuredClone(node), provenance: { ...node.provenance, lastTouched: now } });
		return { graph: next, applied: true, reason: null };
	}
	if (proposal.action === "update_node") {
		const target = nodes.find((n) => n.id === proposal.node!.id);
		if (!target) return refuse(`node ${proposal.node!.id} not found`);
		if (proposal.node!.summary) target.summary = proposal.node!.summary;
		if (proposal.node!.source) target.source = proposal.node!.source;
		target.provenance = {
			cardId: proposal.node!.provenance.cardId,
			commit: proposal.node!.provenance.commit,
			confidence: Math.min(1, target.provenance.confidence + 0.15),
			lastTouched: now,
		};
		return { graph: next, applied: true, reason: null };
	}
	if (proposal.action === "retire_node") {
		const id = proposal.node!.id;
		if (!nodes.some((n) => n.id === id)) return refuse(`node ${id} not found`);
		next.nodes = nodes.filter((n) => n.id !== id);
		next.edges = edges.filter((e) => e.from !== id && e.to !== id);
		return { graph: next, applied: true, reason: null };
	}

	const edgeId = proposal.edge!.id;
	if (proposal.action === "add_edge") {
		const edge = proposal.edge!;
		if (edges.some((e) => e.id === edgeId)) return refuse(`edge ${edgeId} already exists`);
		const known = new Set(nodes.map((n) => n.id));
		if (!known.has(edge.from) || !known.has(edge.to)) return refuse(`edge ${edgeId} has an unknown endpoint`);
		edges.push({ ...structuredClone(edge), provenance: { ...edge.provenance, lastTouched: now } });
		return { graph: next, applied: true, reason: null };
	}
	// retire_edge
	const index = edges.findIndex((e) => e.id === edgeId);
	if (index === -1) return refuse(`edge ${edgeId} not found`);
	edges.splice(index, 1);
	return { graph: next, applied: true, reason: null };
};

/** Empty proposals shell — a project with no finished cards yet. */
export const emptyProposals = (projectId: string): ProposalsFile => ({
	version: PROPOSALS_FILE_VERSION,
	projectId,
	proposals: [],
});

/** Validate a parsed proposals file, same contract as validateGraph: reject, don't coerce. */
export const validateProposalsFile = (value: unknown): value is ProposalsFile => {
	if (value === null || typeof value !== "object") return false;
	const f = value as Partial<ProposalsFile>;
	if (f.version !== PROPOSALS_FILE_VERSION) return false;
	if (typeof f.projectId !== "string") return false;
	if (!Array.isArray(f.proposals)) return false;
	return f.proposals.every(
		(p) =>
			p !== null &&
			typeof p === "object" &&
			typeof p.id === "string" &&
			typeof p.projectId === "string" &&
			typeof p.cardId === "string" &&
			isAction(p.action) &&
			typeof p.evidence === "string" &&
			(p.status === "pending" || p.status === "accepted" || p.status === "rejected") &&
			typeof p.createdAt === "number" &&
			(p.node === null || (typeof p.node === "object" && typeof p.node.id === "string" && isNodeKind(p.node.kind))) &&
			(p.edge === null || (typeof p.edge === "object" && typeof p.edge.id === "string" && isEdgeKind(p.edge.kind))),
	);
};
