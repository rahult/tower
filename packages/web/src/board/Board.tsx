import type { Card, Project } from "@traffic-control/core";
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
	return (
		<div className="overflow-x-auto pb-2">
			<div className="grid min-w-max gap-x-0.5 gap-y-2" style={{ gridTemplateColumns: "11rem repeat(7, minmax(13.5rem, 1fr))" }}>
				<div className="sticky left-0 z-10 bg-rail" />
				{STAGE_COLUMNS.map(({ stage, label }) => {
					const count = cards.filter((card) => card.stage === stage).length;
					return (
						<h2 key={stage} className="condensed px-2 pb-1 text-[15px] font-semibold text-dust">
							{label} {count > 0 && <span className="font-normal">{count}</span>}
						</h2>
					);
				})}
				{projects.map((project) => (
					<Lane key={project.id} project={project} cards={cards.filter((card) => card.projectId === project.id)} selectedCardId={selectedCardId} onOpen={onOpen} />
				))}
			</div>
		</div>
	);
}
