import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Card } from "@tower/core";
import { api, type FlowInfo } from "../api/client.ts";
import { ConfirmButton } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { toast } from "../app/toasts.tsx";
import { flowEdges, stepKind } from "./graph.ts";
import { ComposeDialog } from "./ComposeDialog.tsx";
import { FlowEditor } from "./FlowEditor.tsx";

/** Where a node's work happens, as one word: the gate or the brain. */
const kindGlyph = (flow: FlowInfo) => flow.steps.map((step) => (stepKind(step) === "command" ? "▸" : "✦")).join(" ");

/** The Flows view: every flow on the board, the editor for one of them, and the composer's drafts. */
export function Flows({ cards, onOpenCard }: { cards: Card[]; onOpenCard: (cardId: string) => void }) {
	const queryClient = useQueryClient();
	const flows = useQuery({ queryKey: ["flows"], queryFn: api.flows });
	const [editing, setEditing] = useState<FlowInfo | null>(null);
	const [composing, setComposing] = useState(false);

	if (editing) {
		return (
			<div className="page flow-page">
				<FlowEditor initial={editing} onClose={() => (setEditing(null), void queryClient.invalidateQueries({ queryKey: ["flows"] }))} />
			</div>
		);
	}

	return (
		<div className="page flow-page">
			<header className="page-head">
				<div>
					<h1>Flows</h1>
					<p className="lead">
						A flow is a small state machine a task passes through: command gates that prove, agent steps that judge, and edges that say where each verdict goes.
					</p>
				</div>
				<div className="flex gap-2">
					<button
						type="button"
						className="btn"
						onClick={() => {
							if (cards.length === 0) return toast("Add a card first — the composer designs from a task's brief.");
							setComposing(true);
						}}
					>
						<Icon name="spark" /> Compose from a card
					</button>
					<button
						type="button"
						className="btn primary"
						onClick={() =>
							setEditing({
								name: "my-flow",
								title: "My flow",
								description: "",
								when: ["manual"],
								steps: [{ name: "check", run: "true" }],
							})
						}
					>
						<Icon name="plus" /> New flow
					</button>
				</div>
			</header>
			<ul className="flow-wall">
				{(flows.data?.flows ?? []).map((flow) => (
					<li key={flow.name}>
						<div role="button" tabIndex={0} className="flow-card" onClick={() => setEditing(flow)} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), setEditing(flow))} aria-label={`Edit ${flow.title}`}>
							<header>
								<strong>{flow.title}</strong>
								<span className={`chip ${flow.source === "custom" ? "yours" : ""}`}>{flow.source === "custom" ? "yours" : "shipped"}</span>
							</header>
							<p>{flow.description}</p>
							<footer>
								<span className="mono">{kindGlyph(flow)}</span>
								<span>
									{flow.steps.length} node{flow.steps.length === 1 ? "" : "s"} · {flowEdges(flow).filter((edge) => edge.explicit).length} wire{flowEdges(flow).filter((edge) => edge.explicit).length === 1 ? "" : "s"}
								</span>
								<span className="grow" />
								{flow.when.map((trigger) => (
									<span key={trigger} className={`chip ${trigger === "manual" ? "" : "amber"}`}>
										{trigger}
									</span>
								))}
							</footer>
						</div>
						{flow.source === "custom" && (
							<div className="flow-card-actions">
								<ConfirmButton
									small
									label="Delete"
									confirmLabel="Really delete?"
									onConfirm={() =>
										void api
											.deleteFlow(flow.name)
											.then(() => {
												toast(`Deleted "${flow.name}".`);
												void queryClient.invalidateQueries({ queryKey: ["flows"] });
											})
											.catch((error: Error) => toast(error.message))
									}
								/>
							</div>
						)}
					</li>
				))}
			</ul>
			{composing && <ComposeDialog cards={cards} onOpenCard={onOpenCard} onClose={() => setComposing(false)} onSaved={(flow) => (setComposing(false), setEditing(flow))} />}
		</div>
	);
}
