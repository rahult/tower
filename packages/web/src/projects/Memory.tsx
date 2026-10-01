import type { MemoryEdge, MemoryNode, NodeKind, Project } from "@tower/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { Icon } from "../app/icons.tsx";

/** Node kinds in the order a planner scans them: what it is, who acts, how it flows, what holds. */
const KIND_ORDER: Array<{ kind: NodeKind; label: string }> = [
	{ kind: "domain", label: "Domains" },
	{ kind: "entity", label: "Entities" },
	{ kind: "actor", label: "Actors" },
	{ kind: "flow", label: "Flows" },
	{ kind: "invariant", label: "Invariants" },
	{ kind: "gotcha", label: "Gotchas" },
	{ kind: "failure_mode", label: "Failure modes" },
];

/**
 * A project's living memory: the graph finished cards proposed into and planners read, plus the
 * exact system-model projection they are handed. Pending proposals link out to the project's
 * settings, where each one waits for a person's word.
 */
export function Memory({ project, onBack, onReviewProposals }: { project: Project; onBack: () => void; onReviewProposals: () => void }) {
	const query = useQuery({ queryKey: ["project-memory", project.id], queryFn: () => api.projectMemory(project.id), refetchInterval: 15_000 });
	const data = query.data;
	const graph = data?.graph ?? null;
	const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
	const edgesByFrom = new Map<string, MemoryEdge[]>();
	for (const edge of graph?.edges ?? []) {
		const list = edgesByFrom.get(edge.from) ?? [];
		list.push(edge);
		edgesByFrom.set(edge.from, list);
	}
	return (
		<section className="view active" aria-label="Memory">
			<div className="page">
				<div className="page-in">
					<div className="flex flex-wrap items-start gap-x-6 gap-y-3">
						<div className="flex min-w-0 flex-1 items-start gap-2">
							<button type="button" className="btn sm mt-1.5 shrink-0" onClick={onBack} title="Back to projects">
								<Icon name="back" />
								Projects
							</button>
							<div className="min-w-0 flex-1">
								<h1>{project.name}</h1>
								<p className="lead">The living memory of this codebase: what finished cards confirmed they learned — domains, actors, invariants, gotchas — and the projection every planner reads.</p>
							</div>
						</div>
					</div>

					{query.isPending && <p className="text-[14px] text-slate">Reading the graph…</p>}
					{query.error && <p className="error">{query.error.message}</p>}

					{data && !graph && (
						<div className="empty">
							<strong>No memory yet</strong>
							<span>When cards land, they propose what they learned — confirm proposals on the board and this graph grows.</span>
						</div>
					)}

					{graph && data && (
						<>
							<div className="mt-4 flex flex-wrap items-center gap-2">
								<span className="chip">
									{graph.nodes.length} node{graph.nodes.length === 1 ? "" : "s"} · {graph.edges.length} edge{graph.edges.length === 1 ? "" : "s"}
								</span>
								{data.pendingProposals > 0 ? (
									<button type="button" className="chip needs" title="Review the pending proposals in this project's settings" onClick={onReviewProposals}>
										{data.pendingProposals} proposal{data.pendingProposals === 1 ? "" : "s"} pending
									</button>
								) : (
									<span className="chip ok">Nothing pending</span>
								)}
							</div>

							{data.systemModel && (
								<section className="mt-6">
									<h2 className="text-[15px] font-semibold">System model</h2>
									<p className="mt-0.5 text-[13px] text-slate">The exact projection every planner reads before planning work on this codebase.</p>
									<pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-rule bg-sheet p-4 font-mono text-[13px] leading-relaxed">{query.data.systemModel}</pre>
								</section>
							)}

							{KIND_ORDER.map(({ kind, label }) => {
								const nodes = graph.nodes.filter((node) => node.kind === kind);
								if (nodes.length === 0) return null;
								return (
									<section key={kind} className="mt-6">
										<h2 className="text-[15px] font-semibold">
											{label} <span className="font-normal text-slate">{nodes.length}</span>
										</h2>
										<ul className="mt-2 grid gap-2">
											{nodes.map((node) => (
												<NodeCard key={node.id} node={node} edges={edgesByFrom.get(node.id) ?? []} byId={byId} />
											))}
										</ul>
									</section>
								);
							})}
						</>
					)}
				</div>
			</div>
		</section>
	);
}

function NodeCard({ node, edges, byId }: { node: MemoryNode; edges: MemoryEdge[]; byId: Map<string, MemoryNode> }) {
	const linked = edges.flatMap((edge) => {
		const target = byId.get(edge.to);
		return target ? [{ edge, target }] : [];
	});
	return (
		<li className="rounded-lg border border-rule bg-sheet p-3">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<strong className="text-[14px]">{node.name}</strong>
				<span className="ml-auto shrink-0 font-mono text-[12px] text-slate">
					{Math.round(node.provenance.confidence * 100)}% · touched {new Date(node.provenance.lastTouched).toLocaleDateString()}
				</span>
			</div>
			<p className="mt-1 text-[13px] text-slate">{node.summary}</p>
			{node.source && (
				<code className="mt-1 block truncate font-mono text-[12px] text-slate" title={node.source}>
					{node.source}
				</code>
			)}
			{linked.length > 0 && (
				<ul className="mt-2 border-t border-rule pt-2">
					{linked.map(({ edge, target }) => (
						<li key={edge.id} className="font-mono text-[12px] text-slate">
							{edge.kind} → {target.name}
						</li>
					))}
				</ul>
			)}
		</li>
	);
}
