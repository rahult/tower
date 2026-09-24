import type { Card, Project } from "@tower/core";
import type { Usage } from "../api/client.ts";
import { isLive, needsYou } from "../board/status.ts";
import { Icon } from "../app/icons.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";

interface ProjectsProps {
	projects: Project[];
	cards: Card[];
	usage: Usage | undefined;
	onAddWork: (projectId?: string) => void;
	onAddProject: () => void;
}

/** Every project as a sheet: what it is, how it judges work, and the levers that change that. */
export function Projects({ projects, cards, usage, onAddWork, onAddProject }: ProjectsProps) {
	const spend = new Map((usage?.byProject ?? []).map((row) => [row.key, row]));
	return (
		<section className="view active" aria-label="Projects">
			<div className="page">
				<div className="page-in">
					<div>
						<h1>Projects</h1>
						<p className="lead">
							A repository becomes a project the first time you add a card for it. Each project decides how its builds are judged and how many cards run at once.
						</p>
					</div>
					{projects.length === 0 ? (
						<div className="empty">
						<strong>No projects yet</strong>
						<span>A project is a git repository on this machine; its cards get their own worktrees.</span>
						<button type="button" className="btn primary" onClick={onAddProject}>
							<Icon name="plus" />
							Add a project
						</button>
					</div>
					) : (
						projects.map((project) => (
							<ProjectSheet key={project.id} project={project} cards={cards.filter((card) => card.projectId === project.id)} spend={spend.get(project.id)} onAddWork={() => onAddWork(project.id)} />
						))
					)}
				</div>
			</div>
		</section>
	);
}

function ProjectSheet({
	project,
	cards,
	spend,
	onAddWork,
}: {
	project: Project;
	cards: Card[];
	spend: { runs: number; tokens: number; costUsd: number } | undefined;
	onAddWork: () => void;
}) {
	const running = cards.filter(isLive).length;
	const waiting = cards.filter((card) => needsYou(card) || card.status === "abandoned").length;
	return (
		<section className="sheet" aria-labelledby={`ph-${project.id}`}>
			<div className="sheet-head">
				<h2 id={`ph-${project.id}`}>{project.name}</h2>
				<span className="meta mono hide-sm" title={project.repoPath}>
					{project.repoPath}
				</span>
				<span className="spacer" />
				{waiting > 0 && (
					<span className="chip needs" title={`${waiting} cards need you`}>
						{waiting} need you
					</span>
				)}
				{running > 0 && (
					<span className="chip working">
						<span className="dot working" />
						{running} running
					</span>
				)}
				<span className="chip mono">{project.defaultBranch}</span>
				<button type="button" className="btn sm" onClick={onAddWork}>
					<Icon name="plus" />
					Add card
				</button>
			</div>
			<ProjectSettings project={project} showSpend={spend} />
		</section>
	);
}
