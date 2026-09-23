import type { Card, Project, StageRun } from "@tower/core";
import { Fragment, useMemo, useState } from "react";
import { describeCard, isLive, needsYou, STAGE_COLUMNS, STAGE_DESCRIPTIONS, TONE_SUFFIX } from "./status.ts";
import { useElapsed, useMediaQuery } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { NewCardInline } from "./NewCardInline.tsx";
import { ProjectSettings } from "../projects/ProjectSettings.tsx";

interface BoardProps {
	projects: Project[];
	cards: Card[];
	activeRuns: StageRun[];
	selectedCardId: string | null;
	onOpen: (cardId: string) => void;
}

interface Column {
	id: string;
	label: string;
	stages: Card["stage"][];
}

const FOLD_KEY = "tower-folded";

function readFolded(): Set<string> {
	try {
		return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]") as string[]);
	} catch {
		return new Set();
	}
}

/**
 * The board: one swimlane per project, one column per stage, as a single grid so lanes stay aligned.
 * Columns fold to a 40px spine with a vertical label; on a narrow window Testing and Pull request
 * share a column; on a phone the matrix becomes one stacked section per stage.
 */
export function Board({ projects, cards, activeRuns, selectedCardId, onOpen }: BoardProps) {
	const doneCount = cards.filter((card) => card.stage === "done").length;
	// Done is stored, not active work: folded away by default, one click when it is wanted.
	const [showDone, setShowDone] = useState(false);
	const [folded, setFolded] = useState<Set<string>>(readFolded);
	const narrow = useMediaQuery("(max-width: 1400px)");
	const phone = useMediaQuery("(max-width: 768px)");

	const persistFolded = (next: Set<string>) => {
		setFolded(new Set(next));
		try {
			localStorage.setItem(FOLD_KEY, JSON.stringify([...next]));
		} catch {
			// Storage refused; the folds last for this visit.
		}
	};
	const fold = (id: string) => persistFolded(new Set(folded).add(id));
	const unfold = (id: string) => persistFolded(new Set([...folded].filter((x) => x !== id)));

	const columns: Column[] = [];
	for (const { stage, label } of STAGE_COLUMNS) {
		if (stage === "done" && !showDone) continue;
		if (narrow && stage === "testing") {
			columns.push({ id: "mid", label: "Testing · PR", stages: ["testing", "pull_request"] });
			continue;
		}
		if (narrow && stage === "pull_request") continue;
		columns.push({ id: stage, label, stages: [stage] });
	}

	const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
	const startedAt = useMemo(() => {
		const map = new Map<string, number>();
		for (const run of activeRuns) {
			const known = map.get(run.cardId);
			if (known === undefined || run.startedAt < known) map.set(run.cardId, run.startedAt);
		}
		return map;
	}, [activeRuns]);

	const count = (col: Column) => cards.filter((card) => col.stages.includes(card.stage)).length;
	const foldedCount = columns.filter((col) => folded.has(col.id)).length;
	const meta = `${showDone ? `${cards.length} cards` : `${cards.length - doneCount} open${doneCount > 0 ? ` · ${doneCount} done hidden` : ""}`}${foldedCount > 0 ? ` · ${foldedCount} ${foldedCount === 1 ? "column" : "columns"} collapsed` : ""}`;

	return (
		<section className="view active" id="view-board" aria-label="Board">
			<div className="board-head">
				<h1>Board</h1>
				<span className="meta">{meta}</span>
				<span className="spacer" />
				{foldedCount > 0 && (
					<button type="button" className="btn ghost sm" onClick={() => persistFolded(new Set())}>
						Expand all columns
					</button>
				)}
				<button type="button" className="btn sm" aria-pressed={showDone} onClick={() => setShowDone((on) => !on)}>
					{showDone ? "Hide done" : `Show done (${doneCount})`}
				</button>
			</div>
			<div className="board">
				<div
					className="matrix"
					style={
						phone
							? undefined
							: ({ "--matrix-cols": `${narrow ? 180 : 200}px ${columns.map((col) => (folded.has(col.id) ? "var(--fold-w)" : `minmax(${narrow ? 150 : 160}px, 1fr)`)).join(" ")}` } as React.CSSProperties)
					}
				>
					{phone ? (
						<BoardStacked columns={columns} cards={cards} names={names} folded={folded} selectedCardId={selectedCardId} onOpen={onOpen} onFold={fold} onUnfold={unfold} />
					) : (
						<BoardMatrix
							projects={projects}
							cards={cards}
							names={names}
							columns={columns}
							folded={folded}
							startedAt={startedAt}
							selectedCardId={selectedCardId}
							onOpen={onOpen}
							onFold={fold}
							onUnfold={unfold}
						/>
					)}
				</div>
			</div>
		</section>
	);
}

function BoardMatrix({
	projects,
	cards,
	names,
	columns,
	folded,
	startedAt,
	selectedCardId,
	onOpen,
	onFold,
	onUnfold,
}: {
	projects: Project[];
	cards: Card[];
	names: Map<string, string>;
	columns: Column[];
	folded: Set<string>;
	startedAt: Map<string, number>;
	selectedCardId: string | null;
	onOpen: (cardId: string) => void;
	onFold: (id: string) => void;
	onUnfold: (id: string) => void;
}) {
	const [adding, setAdding] = useState<string | null>(null);
	const [configuring, setConfiguring] = useState<string | null>(null);
	const count = (col: Column) => cards.filter((card) => col.stages.includes(card.stage)).length;

	return (
		<>
			<div className="mh first">Project</div>
			{columns.map((col) =>
				folded.has(col.id) ? (
					<button key={col.id} type="button" className="mh folded" onClick={() => onUnfold(col.id)} aria-label={`Expand ${col.label}, ${count(col)} cards`} title={`Expand ${col.label}`}>
						<Icon name="chev-r" />
						<span className="vlabel">
							{col.label}
							{count(col) > 0 && <span className="n"> {count(col)}</span>}
						</span>
					</button>
				) : (
					<div key={col.id} className="mh" title={col.id in STAGE_DESCRIPTIONS ? STAGE_DESCRIPTIONS[col.id as Card["stage"]] : "Testing and pull requests share this column on a narrow window"}>
						<span>{col.label}</span>
						{count(col) > 0 && <span className="n">{count(col)}</span>}
						<button type="button" className="fold" onClick={() => onFold(col.id)} aria-label={`Collapse ${col.label}`} title="Collapse column">
							<Icon name="chev-l" />
						</button>
					</div>
				),
			)}
			{projects.map((project, projectIndex) => {
				const pc = cards.filter((card) => card.projectId === project.id);
				const running = pc.filter(isLive).length;
				const waiting = pc.filter((card) => needsYou(card) || card.status === "abandoned").length;
				// The last lane omits its bottom border so the matrix's own edge draws it.
				const edge = projectIndex === projects.length - 1 ? { borderBottom: "none" as const } : undefined;
				const configuringThis = configuring === project.id;
				const addingThis = adding === project.id;
				return configuringThis ? (
					// The project's own cells are replaced by one full-width row, so every lane stays aligned.
					<div key={project.id} className="bg-sheet p-4" style={{ gridColumn: "1 / -1", ...edge }}>
						<ProjectSettings project={project} onDone={() => setConfiguring(null)} />
					</div>
				) : (
					<Fragment key={project.id}>
						<div className="lane" style={edge}>
							<span className="name">{project.name}</span>
							<span className="branch truncate" title={`${project.repoPath} on ${project.defaultBranch}${project.hasOrigin === false ? " — no origin remote, so finished cards are merged locally instead of opened as pull requests" : ""}`}>
								{project.defaultBranch}
								{project.hasOrigin === false && " · merges locally"}
							</span>
							<span className="meta text-[12px]">
								{running > 0 && <span style={{ color: "var(--primary)", fontWeight: 600 }}>{running} running</span>}
								{running > 0 && waiting > 0 && " · "}
								{waiting > 0 && <span style={{ color: "var(--caution-text)", fontWeight: 600 }}>{waiting} need you</span>}
								{running === 0 && waiting === 0 && "Quiet"}
							</span>
							<span className="meta text-[12px]">{project.verifyCommand ? "Your verify command judges builds" : "No verify command, so an agent judges builds"}</span>
							<div className="acts">
								<button type="button" onClick={() => (setAdding(addingThis ? null : project.id), setConfiguring(null))}>
									{addingThis ? "Cancel" : "Add card"}
								</button>
								<button type="button" onClick={() => (setConfiguring(configuringThis ? null : project.id), setAdding(null))}>
									{configuringThis ? "Close settings" : "Settings"}
								</button>
							</div>
						</div>
						{columns.map((col) => {
							if (folded.has(col.id)) {
								const cs = pc.filter((card) => col.stages.includes(card.stage));
								const tone = foldTone(cs);
								return (
									<button
										key={col.id}
										type="button"
										className="cell folded"
										onClick={() => onUnfold(col.id)}
										aria-label={`Expand ${col.label}: ${cs.length} ${cs.length === 1 ? "card" : "cards"} for ${project.name}`}
										style={edge}
									>
										<span className={`n${cs.length ? "" : " zero"}`}>{cs.length || "–"}</span>
										{tone && <span className={`dot ${tone}`} aria-hidden />}
									</button>
								);
							}
							const cs = pc.filter((card) => col.stages.includes(card.stage));
							const wash = col.id === "backlog" || col.id === "done" || col.id === "mid";
							return (
								<div key={col.id} className={`cell${wash ? " wash" : ""}`} style={edge} aria-label={`${project.name}, ${col.label}`}>
									{col.id === "backlog" && addingThis && <NewCardInline projectId={project.id} onDone={() => setAdding(null)} />}
									{cs.map((card) => (
										<Mini key={card.id} card={card} projectName={names.get(card.projectId)} startedAt={startedAt.get(card.id)} selected={card.id === selectedCardId} onOpen={() => onOpen(card.id)} />
									))}
									{col.id === "done" && cs.length === 0 && <span className="done-note">—</span>}
								</div>
							);
						})}
					</Fragment>
				);
			})}
		</>
	);
}

function BoardStacked({
	columns,
	cards,
	names,
	folded,
	selectedCardId,
	onOpen,
	onFold,
	onUnfold,
}: {
	columns: Column[];
	cards: Card[];
	names: Map<string, string>;
	folded: Set<string>;
	selectedCardId: string | null;
	onOpen: (cardId: string) => void;
	onFold: (id: string) => void;
	onUnfold: (id: string) => void;
}) {
	return (
		<div className="board-stack">
			{columns.map((col) => {
				const cs = cards.filter((card) => col.stages.includes(card.stage));
				const open = !folded.has(col.id);
				const tone = foldTone(cs);
				return (
					<section key={col.id} className="bsec">
						<button type="button" className="bsec-head" aria-expanded={open} onClick={() => (open ? onFold(col.id) : onUnfold(col.id))}>
							<span>{col.label}</span>
							<span className="n">{cs.length}</span>
							{tone && <span className={`dot ${tone}`} aria-hidden />}
							<span className="chev">
								<Icon name="chev-r" />
							</span>
						</button>
						{open && (
							<div className="bsec-body">
								{cs.length > 0 ? (
									cs.map((card) => <Mini key={card.id} card={card} projectName={names.get(card.projectId)} withProject selected={card.id === selectedCardId} onOpen={() => onOpen(card.id)} />)
								) : (
									<span className="done-note">Nothing in {col.label.toLowerCase()}</span>
								)}
							</div>
						)}
					</section>
				);
			})}
		</div>
	);
}

function foldTone(list: Card[]): "needs" | "working" | null {
	if (list.some((card) => ["needs", "warn"].includes(TONE_SUFFIX[describeCard(card).tone]))) return "needs";
	if (list.some((card) => TONE_SUFFIX[describeCard(card).tone] === "working")) return "working";
	return null;
}

/** A card, drawn small. Amber means it needs you and is filled solid; everything else is a strip. */
function Mini({ card, projectName, startedAt, selected, withProject, onOpen }: { card: Card; projectName: string | undefined; startedAt?: number; selected: boolean; withProject?: boolean; onOpen: () => void }) {
	const { status, tone } = describeCard(card);
	const suffix = TONE_SUFFIX[tone];
	const live = isLive(card);
	const elapsed = useElapsed(startedAt, live, 1000);
	const sub =
		tone === "caution"
			? needsLabel(card)
			: live
				? `Running · ${elapsed}`
				: card.stage === "pull_request" && card.status === "idle"
					? "Open, being watched"
					: card.stage === "done"
						? "Merged"
						: status;
	return (
		<button type="button" className={`mini ${suffix}${selected ? " selected" : ""}`} onClick={onOpen} data-id={card.id} aria-label={`Open ${card.title}`}>
			<span className="bar" aria-hidden />
			<span className="in">
				<span className="t line-clamp-2">{card.title}</span>
				<span className="s">
					<span className="truncate">
						{withProject && projectName && <span className="proj-tag">{projectName} · </span>}
						{sub}
					</span>
					<span>{card.id}</span>
				</span>
			</span>
		</button>
	);
}

function needsLabel(card: Card): string {
	if (card.status === "awaiting_gate") return card.stage === "feedback" ? "Review work" : "Approve plan";
	if (card.status === "awaiting_input") return "Answer the agent";
	return "Needs you";
}
