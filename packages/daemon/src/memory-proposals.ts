import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	applyProposal,
	type Card,
	type GraphProposal,
	emptyGraph,
	emptyProposals,
	parseLearnReport,
	validateProposalsFile,
	type ProposalsFile,
} from "@tower/core";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { ConflictError } from "./errors.ts";
import { readGraph, writeGraph, writeProjectedModel } from "./memory-graph.ts";

export const proposalsPath = (config: Config, projectId: string): string =>
	join(paths.projectDir(config, projectId), "memory-proposals.json");

export const readProposals = (config: Config, projectId: string): ProposalsFile => {
	const file = proposalsPath(config, projectId);
	if (!existsSync(file)) return emptyProposals(projectId);
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return validateProposalsFile(parsed) && parsed.projectId === projectId ? parsed : emptyProposals(projectId);
	} catch {
		return emptyProposals(projectId);
	}
};

/** Atomic write: temp file then rename, same contract as the graph store. */
export const writeProposals = (config: Config, projectId: string, file: ProposalsFile): void => {
	if (!validateProposalsFile(file) || file.projectId !== projectId) throw new Error("refusing to write an invalid proposals file");
	const target = proposalsPath(config, projectId);
	mkdirSync(dirname(target), { recursive: true });
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
	renameSync(tmp, target);
};

/**
 * The post-card learn step (spec Phase 2): read the builder's learn.json, validate it into
 * proposals, drop the ones the graph already knows or that are already pending, and file the
 * rest for a human. Best-effort by contract — the card has finished either way.
 */
export const learnFromCard = (options: { config: Config; card: Card; commit: string }): GraphProposal[] => {
	const { config, card, commit } = options;
	const learnPath = join(paths.cardDir(config, card.id), "learn.json");
	if (!existsSync(learnPath)) return [];
	let raw: unknown = null;
	try {
		raw = JSON.parse(readFileSync(learnPath, "utf8"));
	} catch {
		return [];
	}
	const proposals = parseLearnReport(raw, { projectId: card.projectId, cardId: card.id, commit, now: Date.now() });
	if (proposals.length === 0) return [];

	const file = readProposals(config, card.projectId);
	const graph = readGraph(config, card.projectId);
	const knownNodeIds = new Set(graph?.nodes.map((n) => n.id) ?? []);
	const knownEdgeIds = new Set(graph?.edges.map((e) => e.id) ?? []);
	const pendingIds = new Set(file.proposals.filter((p) => p.status === "pending").map((p) => p.id));
	const fresh = proposals.filter((p) => {
		if (pendingIds.has(p.id)) return false;
		if (p.action === "add_node" && knownNodeIds.has(p.node!.id)) return false;
		if (p.action === "add_edge" && knownEdgeIds.has(p.edge!.id)) return false;
		return true;
	});
	if (fresh.length === 0) return [];
	file.proposals = [...file.proposals, ...fresh];
	writeProposals(config, card.projectId, file);
	return fresh;
};

export const decideProposal = (options: {
	config: Config;
	projectId: string;
	proposalId: string;
	decision: "accept" | "reject";
}): { proposal: GraphProposal; applied: boolean; reason: string | null } => {
	const { config, projectId, proposalId, decision } = options;
	const file = readProposals(config, projectId);
	const proposal = file.proposals.find((p) => p.id === proposalId);
	if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
	if (proposal.status !== "pending") throw new ConflictError(`Proposal ${proposalId} is already ${proposal.status}`);

	if (decision === "accept") {
		const graph = readGraph(config, projectId) ?? emptyGraph(projectId);
		const result = applyProposal(graph, proposal, Date.now());
		// The codebase wins on conflict: a refused change stays pending for the human to reject or a
		// later card to fix, and never half-enters the graph.
		if (!result.applied) return { proposal, applied: false, reason: result.reason };
		writeGraph(config, projectId, result.graph);
		writeProjectedModel(config, projectId, result.graph);
		proposal.status = "accepted";
	} else {
		proposal.status = "rejected";
		proposal.decidedAt = Date.now();
		writeProposals(config, projectId, file);
		return { proposal, applied: false, reason: null };
	}
	proposal.decidedAt = Date.now();
	writeProposals(config, projectId, file);
	return { proposal, applied: true, reason: null };
};
