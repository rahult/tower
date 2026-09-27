import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import type { FlowInfo } from "../api/client.ts";
import { type Edge, flowEdges, NODE_H, nodePositions, NODE_W, stepKind, unreachableNodes } from "./graph.ts";

/** The gap between node columns, matching the layout in graph.ts. */
const COL_GAP = 96;

interface FlowGraphProps {
	flow: FlowInfo;
	/** The selected node, if the parent tracks selection. */
	selected?: string | null;
	onSelect?: (name: string) => void;
	/** A node was dragged somewhere: the parent persists it into flow.layout. */
	onMove?: (name: string, x: number, y: number) => void;
	/** A drag from one node's port landed on another node: an edge is being wired. */
	onConnect?: (from: string, to: string, verdict: "pass" | "fail") => void;
}

/** Where an edge leaves one node and meets the next. Verdicts anchor at their own port heights, so a pass/fail pair between the same two nodes draws as two parallel lines, not one. */
function anchor(position: { x: number; y: number }, side: "out" | "in", verdict: "pass" | "fail"): { x: number; y: number } {
	return { x: position.x + (side === "out" ? NODE_W : 0), y: position.y + (verdict === "pass" ? 24 : 46) };
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, lift: number): string {
	const bend = Math.min(90, Math.max(36, Math.abs(to.x - from.x) / 2));
	return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y - lift}, ${to.x - bend} ${to.y - lift}, ${to.x} ${to.y}`;
}

/** A hop wider than one column arcs above the row, so it never runs through the node it skips past. */
const hopLift = (dx: number): number => (dx > NODE_W + COL_GAP + 40 ? 44 : 0);

/** Node cards are 172 wide and the text starts at 44 — this is what fits before the ports. */
const fit = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** A self-edge (a node routed back into itself) loops over the node's top. */
function selfPath(position: { x: number; y: number }): string {
	const { x, y } = position;
	return `M ${x + NODE_W} ${y + 18} C ${x + NODE_W + 44} ${y + 18}, ${x + NODE_W + 44} ${y - 18}, ${x + NODE_W / 2} ${y - 18} L ${x + NODE_W / 2} ${y}`;
}

/** The graph canvas: nodes as cards, verdicts as labeled edges. Drags a node to move it; drags a port to wire an edge. */
export function FlowGraph({ flow, selected, onSelect, onMove, onConnect }: FlowGraphProps) {
	const svgRef = useRef<SVGSVGElement | null>(null);
	const [dragging, setDragging] = useState<{ name: string; dx: number; dy: number; x: number; y: number } | null>(null);
	const [wire, setWire] = useState<{ from: string; verdict: "pass" | "fail"; x: number; y: number } | null>(null);

	const toCanvas = (clientX: number, clientY: number): { x: number; y: number } => {
		const rect = svgRef.current?.getBoundingClientRect();
		return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
	};

	const startDrag = (name: string, event: ReactPointerEvent<SVGGElement>) => {
		const position = positions[name];
		if (!onMove || !position) return;
		const point = toCanvas(event.clientX, event.clientY);
		setDragging({ name, dx: point.x - position.x, dy: point.y - position.y, x: position.x, y: position.y });
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const moveDrag = (event: ReactPointerEvent<SVGGElement>) => {
		if (!dragging) return;
		const point = toCanvas(event.clientX, event.clientY);
		setDragging({ ...dragging, x: point.x - dragging.dx, y: point.y - dragging.dy });
	};
	const endDrag = () => {
		if (!dragging) return;
		onMove?.(dragging.name, Math.max(0, dragging.x), Math.max(0, dragging.y));
		setDragging(null);
	};

	// Wiring an edge: a port drags a live line; dropping it on another node asks the parent to
	// connect that verdict. The listeners live on window, since the release usually happens over
	// another node.
	const startWire = (name: string, verdict: "pass" | "fail", event: ReactPointerEvent<SVGGElement>) => {
		if (!onConnect) return;
		event.stopPropagation();
		setWire({ from: name, verdict, ...toCanvas(event.clientX, event.clientY) });
		const move = (moveEvent: PointerEvent) => setWire({ from: name, verdict, ...toCanvas(moveEvent.clientX, moveEvent.clientY) });
		const up = (upEvent: PointerEvent) => {
			window.removeEventListener("pointermove", move);
			const landed = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest("[data-node]")?.getAttribute("data-node");
			setWire(null);
			if (landed && landed !== name) onConnect(name, landed, verdict);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up, { once: true });
	};

	// The canvas fits its graph, with room to spare so a small flow still has air around it.
	const positions = nodePositions(flow);
	const drawn = { ...positions, ...(dragging ? { [dragging.name]: { x: dragging.x, y: dragging.y } } : {}) };
	const width = Math.max(760, ...Object.values(drawn).map((p) => p.x + NODE_W + 80));
	const height = Math.max(240, ...Object.values(drawn).map((p) => p.y + NODE_H + 60));
	const edges = flowEdges(flow);
	const broken = new Set(unreachableNodes(flow));

	const renderEdge = (edge: Edge) => {
		const from = drawn[edge.from];
		const to = drawn[edge.to];
		if (!from || !to) return null;
		const self = edge.from === edge.to;
		const lift = self ? 0 : hopLift(anchor(to, "in", edge.verdict).x - anchor(from, "out", edge.verdict).x);
		const d = self ? selfPath(from) : edgePath(anchor(from, "out", edge.verdict), anchor(to, "in", edge.verdict), lift);
		const at = self
			? { x: from.x + NODE_W / 2, y: from.y - 26 }
			: { x: (anchor(from, "out", edge.verdict).x + anchor(to, "in", edge.verdict).x) / 2, y: (anchor(from, "out", edge.verdict).y + anchor(to, "in", edge.verdict).y) / 2 - lift * 0.75 };
		return (
			<g key={`${edge.from}-${edge.verdict}-${edge.to}`} className={edge.verdict === "fail" ? "flow-edge fail" : edge.explicit ? "flow-edge" : "flow-edge implicit"}>
				<path d={d} markerEnd={`url(#arrow-${edge.verdict})`} />
				{edge.explicit && (
					<g transform={`translate(${at.x} ${at.y})`}>
						<rect className={`flow-edge-chip ${edge.verdict}`} x={-22} y={-9} width={44} height={18} rx={9} />
						<text className={`flow-edge-text ${edge.verdict}`} textAnchor="middle" dominantBaseline="central">
							{edge.verdict}
						</text>
					</g>
				)}
			</g>
		);
	};

	// The viewBox makes the whole graph scale with its CSS box (the compose dialog shrinks it to fit);
	// without it, a resized svg crops instead of scaling.
	return (
		<svg ref={svgRef} className="flow-canvas" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Flow graph: ${flow.steps.map((step) => step.name).join(", ")}`}>
			<defs>
				<marker id="arrow-pass" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
					<path d="M 0 1 L 9 5 L 0 9" fill="none" className="flow-arrow pass" />
				</marker>
				<marker id="arrow-fail" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
					<path d="M 0 1 L 9 5 L 0 9" fill="none" className="flow-arrow fail" />
				</marker>
			</defs>
			{edges.map(renderEdge)}
			{wire && (() => {
				const origin = anchor(drawn[wire.from] ?? { x: 0, y: 0 }, "out", wire.verdict);
				return <path className="flow-wire" d={`M ${origin.x} ${origin.y} L ${wire.x} ${wire.y}`} />;
			})()}
			{flow.steps.map((step) => {
				const position = drawn[step.name];
				if (!position) return null;
				const kind = stepKind(step);
				const isStart = (flow.start ?? flow.steps[0]?.name) === step.name;
				return (
					<g
						key={step.name}
						data-node={step.name}
						className={`flow-node ${kind}${selected === step.name ? " selected" : ""}${broken.has(step.name) ? " broken" : ""}`}
						transform={`translate(${position.x} ${position.y})`}
						onPointerDown={(event) => startDrag(step.name, event)}
						onPointerMove={moveDrag}
						onPointerUp={endDrag}
						onClick={() => onSelect?.(step.name)}
					>
						<rect width={NODE_W} height={NODE_H} rx={10} />
						<g className={`flow-node-glyph ${kind}`} transform="translate(24 29)">
							<text textAnchor="middle" dominantBaseline="central">{kind === "command" ? ">_" : "✦"}</text>
						</g>
						<text className="flow-node-name" x={44} y={22}>
							{fit(step.name, 15)}
						</text>
						<text className="flow-node-sub" x={44} y={40}>
							{fit(
								kind === "command"
									? (step.expect === "note" ? "note · never fails" : "exit code decides")
									: kind === "text"
										? (step.text ?? "").replace(/\s+/g, " ").trim() || "agent step"
										: kind === "prompt"
											? (step.prompt ?? "")
											: kind === "skill"
												? `/skill:${step.skill ?? ""}`
												: `@${step.agent ?? ""}`,
								20,
							)}
						</text>
						{isStart && <rect className="flow-node-start" width={3} height={NODE_H} rx={1.5} />}
						{step.maxRuns !== undefined && (
							<g transform={`translate(${NODE_W - 28} 8)`}>
								<rect className="flow-node-cap" width={24} height={15} rx={7.5} />
								<text className="flow-node-cap-text" x={12} y={8} textAnchor="middle" dominantBaseline="central">
									×{step.maxRuns}
								</text>
							</g>
						)}
						{(["pass", "fail"] as const)
							.filter((verdict) => !(step.expect === "note" && verdict === "fail"))
							.map((verdict, index) => (
								<g key={verdict} className={`flow-port ${verdict}`} transform={`translate(${NODE_W} ${24 + index * 22})`} onPointerDown={(event) => startWire(step.name, verdict, event)}>
									<title>{`Drag to wire the ${verdict} edge`}</title>
									<circle r={10} className="flow-port-hit" />
									<circle r={4} className={`flow-port-dot ${verdict}`} />
								</g>
							))}
					</g>
				);
			})}
		</svg>
	);
}
