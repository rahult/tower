import type { FlowInfo, FlowStepInfo } from "../api/client.ts";

/** What a node does, derived from which action field it carries. */
export type StepKind = "command" | "text" | "prompt" | "skill" | "agent";

export function stepKind(step: FlowStepInfo): StepKind {
	if (step.run !== undefined) return "command";
	if (step.text !== undefined) return "text";
	if (step.prompt !== undefined) return "prompt";
	if (step.skill !== undefined) return "skill";
	if (step.agent !== undefined) return "agent";
	return "text";
}

export const KIND_LABEL: Record<StepKind, string> = { command: "Command", text: "Agent", prompt: "Prompt file", skill: "Skill", agent: "Agent role" };

/** The verdicts an edge can carry. A note step never fails, so it draws no fail edge. */
export function verdicts(step: FlowStepInfo): Array<"pass" | "fail"> {
	return step.run !== undefined && step.expect === "note" ? ["pass"] : ["pass", "fail"];
}

/** Where a verdict goes: the explicit edge, else the next step in file order, else the flow ends. Mirrors the runner. */
export function nextTarget(flow: FlowInfo, step: FlowStepInfo, verdict: "pass" | "fail"): string | null {
	const target = step.on?.[verdict];
	if (target) return flow.steps.some((candidate) => candidate.name === target) ? target : null;
	const index = flow.steps.indexOf(step);
	return (index >= 0 ? flow.steps[index + 1] : undefined)?.name ?? null;
}

/** One drawn edge: explicit edges are labeled, implicit fallthroughs render faded. */
export interface Edge {
	from: string;
	to: string;
	verdict: "pass" | "fail";
	explicit: boolean;
}

export function flowEdges(flow: FlowInfo): Edge[] {
	const edges: Edge[] = [];
	for (const step of flow.steps) {
		for (const verdict of verdicts(step)) {
			const to = nextTarget(flow, step, verdict);
			if (to) edges.push({ from: step.name, to, verdict, explicit: step.on?.[verdict] !== undefined });
		}
	}
	return edges;
}

export const NODE_W = 172;
export const NODE_H = 58;
const COL_GAP = 96;
const ROW_GAP = 32;

/**
 * Layered layout: every node sits in the column of its longest path from the start, centered within
 * its column. Back-edges (a repair loop returning) climb no further — they would push their target
 * column after column and walk the graph off the canvas.
 */
export function layoutNodes(flow: FlowInfo): Record<string, { x: number; y: number }> {
	const outgoing = new Map<string, string[]>();
	for (const step of flow.steps) outgoing.set(step.name, []);
	for (const edge of flowEdges(flow)) outgoing.get(edge.from)?.push(edge.to);
	const depth = new Map<string, number>();
	const onStack = new Set<string>();
	const walk = (name: string, at: number) => {
		if (onStack.has(name)) return; // the loop returns here; its column is already set
		const known = depth.get(name);
		if (known !== undefined && known >= at) return;
		depth.set(name, at);
		onStack.add(name);
		for (const to of outgoing.get(name) ?? []) walk(to, at + 1);
		onStack.delete(name);
	};
	const start = flow.start ?? flow.steps[0]?.name;
	if (start) walk(start, 0);
	const columns = new Map<number, string[]>();
	for (const step of flow.steps) {
		const column = depth.get(step.name) ?? 0;
		const names = columns.get(column) ?? [];
		names.push(step.name);
		columns.set(column, names);
	}
	const positions: Record<string, { x: number; y: number }> = {};
	for (const [column, names] of columns) {
		names.forEach((name, index) => {
			positions[name] = { x: column * (NODE_W + COL_GAP), y: (index - (names.length - 1) / 2) * (NODE_H + ROW_GAP) };
		});
	}
	return positions;
}

/** The editor's saved positions, falling back to the computed layout wherever a node was never dragged — shifted so nothing sits above or left of the canvas. */
export function nodePositions(flow: FlowInfo): Record<string, { x: number; y: number }> {
	const computed = layoutNodes(flow);
	const merged = flow.layout ? Object.fromEntries(Object.entries(computed).map(([name, position]) => [name, flow.layout?.[name] ?? position])) : computed;
	const entries = Object.entries(merged);
	if (entries.length === 0) return merged;
	const minX = Math.min(...entries.map(([, p]) => p.x));
	const minY = Math.min(...entries.map(([, p]) => p.y));
	// Only lift a graph that hangs off the canvas; a deliberate arrangement stays where it was put.
	const dx = minX < 24 ? 24 - minX : 0;
	const dy = minY < 24 ? 24 - minY : 0;
	if (dx === 0 && dy === 0) return merged;
	return Object.fromEntries(entries.map(([name, p]) => [name, { x: p.x + dx, y: p.y + dy }]));
}

/** Nodes the walk can never reach from the start — the editor flags them rather than judging silently. */
export function unreachableNodes(flow: FlowInfo): string[] {
	if (flow.steps.length === 0) return [];
	const start = flow.start ?? flow.steps[0]?.name;
	const seen = new Set<string>(start ? [start] : []);
	let grew = true;
	while (grew) {
		grew = false;
		for (const edge of flowEdges(flow)) {
			if (seen.has(edge.from) && !seen.has(edge.to)) {
				seen.add(edge.to);
				grew = true;
			}
		}
	}
	return flow.steps.map((step) => step.name).filter((name) => !seen.has(name));
}

/** The default name for a new node: never collides with an existing one. */
export function freeStepName(flow: FlowInfo): string {
	const taken = new Set(flow.steps.map((step) => step.name));
	for (let n = 1; ; n++) if (!taken.has(`step-${n}`)) return `step-${n}`;
}

/** A blank flow to start authoring from: one command gate, linear, manual. */
export function blankFlow(): FlowInfo {
	return {
		name: "my-flow",
		title: "My flow",
		description: "",
		when: ["manual"],
		steps: [{ name: "check", run: "true" }],
	};
}

/** Renaming a node rewrites what refers to it: edges, the start, the layout. */
export function renameStep(flow: FlowInfo, from: string, to: string): FlowInfo {
	const fix = (target: string | undefined) => (target === from ? to : target);
	return {
		...flow,
		...(flow.start ? { start: fix(flow.start) } : {}),
		steps: flow.steps.map((step) =>
			step.name === from
				? { ...step, name: to, on: step.on ? Object.fromEntries(Object.entries(step.on).map(([verdict, target]) => [verdict, fix(target) ?? target])) : undefined }
				: step.on
					? { ...step, on: Object.fromEntries(Object.entries(step.on).map(([verdict, target]) => [verdict, fix(target) ?? target])) }
					: step,
		),
		...(flow.layout && flow.layout[from] ? { layout: { ...flow.layout, [to]: flow.layout[from] } } : {}),
	};
}

/** Dropping a node rewrites what referred to it: edges aimed at it now end there — no dangling targets. */
export function removeStep(flow: FlowInfo, name: string): FlowInfo {
	const survivors = flow.steps.filter((step) => step.name !== name);
	const rerouted = survivors.map((step) => {
		if (!step.on) return step;
		const on = Object.fromEntries(Object.entries(step.on).filter(([, target]) => target !== name));
		return Object.keys(on).length ? { ...step, on } : { ...step, on: undefined };
	});
	const start = flow.start === name ? undefined : flow.start;
	return {
		...flow,
		steps: rerouted,
		...(start ? { start } : {}),
		...(flow.layout && flow.layout[name] ? { layout: Object.fromEntries(Object.entries(flow.layout).filter(([key]) => key !== name)) } : {}),
	};
}
