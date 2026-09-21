import type { Card, Project } from "@tower/core";
import { useState } from "react";
import { Lane } from "./Lane.tsx";
import { STAGE_COLUMNS } from "./status.ts";

interface BoardProps {
	projects: Project[];
	cards: Card[];
	selectedCardId: string | null;
	onOpen: (cardId: string) => void;
}

/** The board: one swimlane per project, one column per stage. A single grid keeps every lane's columns aligned. */
export function Board({ projects, cards, selectedCardId, onOpen }: BoardProps) {
	const doneCount = cards.filter((card) => card.stage === "done").length;
	// Done is stored, not active work: folded away by default, one click when it is wanted.
	const [showDone, setShowDone] = useState(false);
	return (
		<div className="overflow-x-auto rounded-lg border border-rule bg-sheet">
			<div className="grid min-w-max" style={{ gridTemplateColumns: "12rem repeat(7, minmax(13.5rem, 1fr))" }}>
				<div className="sticky left-0 z-20 border-b border-rule bg-sheet" />
				{STAGE_COLUMNS.map(({ stage, label }) => {
					const count = cards.filter((card) => card.stage === stage && (stage !== "done" || showDone)).length;
					return (
						<h2 key={stage} className="display flex items-baseline gap-2 border-b border-l border-rule px-3 py-2 text-[15px] font-bold">
							{label}
							{stage === "done" && doneCount > 0 ? (
								<button type="button" onClick={() => setShowDone((on) => !on)} className="cursor-pointer font-sans text-[12px] font-semibold text-primary underline-offset-2 hover:underline">
									{showDone ? count : `${doneCount} hidden`}
								</button>
							) : (
								count > 0 && <span className="font-sans text-[12px] font-semibold text-slate">{count}</span>
							)}
						</h2>
					);
				})}
				{projects.map((project, index) => (
					<Lane
						key={project.id}
						project={project}
						cards={cards.filter((card) => card.projectId === project.id)}
						selectedCardId={selectedCardId}
						onOpen={onOpen}
						showDone={showDone}
						last={index === projects.length - 1}
					/>
				))}
			</div>
		</div>
	);
}
