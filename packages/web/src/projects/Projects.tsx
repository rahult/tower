import type { Card, Project } from "@tower/core";
import type { Usage } from "../api/client.ts";
import { isLive, needsYou } from "../board/status.ts";
import { formatTokens } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";

interface ProjectsProps {
	projects: Project[];
	cards: Card[];
	usage: Usage | undefined;
	onAddWork: (projectId?: string) => void;
	onAddProject: () => void;
	onNewIdea: () => void;
	onPlanToBacklog: (project: Project) => void;
	/** Clicking a card opens the project's editor. */
	onOpenProject: (project: Project) => void;
}

/**
 * The project space: a wall of cards — one per project, scannable at a glance — with adding a project
 * always one click away. Clicking a card opens its editor, where the agent drafts the commands.
 */
export function Projects({ projects, cards, usage, onAddWork, onAddProject, onNewIdea, onPlanToBacklog, onOpenProject }: ProjectsProps) {
	const spend = new Map((usage?.byProject ?? []).map((row) => [row.key, row]));
	return (
		<section className="view active" aria-label="Projects">
			<div className="page">
				<div className="page-in">
					<div className="flex flex-wrap items-start gap-x-6 gap-y-3">
						<div className="flex min-w-0 flex-1">
							<h1>Projects</h1>
							<p className="lead">A project is a git repository on this machine — or an idea scaffolded from an archetype. Click one to edit how its builds are judged.</p>
						</div>
						<div className="mt-1.5 flex shrink-0 gap-2">
							<button type="button" className="btn primary" onClick={onNewIdea} title="Scaffold a project from an idea">
								<Icon name="spark" />
								New from idea
							</button>
							<button type="button" className="btn" onClick={onAddProject}>
								<Icon name="plus" />
								Add a project
							</button>
						</div>
					</div>
					{projects.length === 0 ? (
						<div className="empty">
							<strong>No projects yet</strong>
							<span>Start from an idea — Tower scaffolds the repository and plans the first card — or add a repository that already exists.</span>
							<div className="flex justify-center gap-2">
								<button type="button" className="btn primary" onClick={onNewIdea}>
									<Icon name="spark" />
									New from idea
								</button>
								<button type="button" className="btn" onClick={onAddProject}>
									<Icon name="plus" />
									Add a project
								</button>
							</div>
						</div>
					) : (
						<ul className="grid grid-cols-[repeat(auto-fill,minmax(21rem,1fr))] gap-3">
							{projects.map((project) => (
								<ProjectCard
									key={project.id}
									project={project}
									cards={cards.filter((card) => card.projectId === project.id)}
									spend={spend.get(project.id)}
									onOpen={() => onOpenProject(project)}
									onAddWork={() => onAddWork(project.id)}
									onPlanToBacklog={() => onPlanToBacklog(project)}
								/>
							))}
						</ul>
					)}
				</div>
			</div>
		</section>
	);
}

function ProjectCard({
	project,
	cards,
	spend,
	onOpen,
	onAddWork,
	onPlanToBacklog,
}: {
	project: Project;
	cards: Card[];
	spend: { runs: number; tokens: number; costUsd: number } | undefined;
	onOpen: () => void;
	onAddWork: () => void;
	onPlanToBacklog: () => void;
}) {
	const running = cards.filter(isLive).length;
	const waiting = cards.filter((card) => needsYou(card) || card.status === "abandoned").length;
	const open = cards.filter((card) => card.stage !== "done").length;
	const reviewCount = project.reviewFlows?.length;
	return (
		<li
			role="button"
			tabIndex={0}
			aria-label={`Open ${project.name}`}
			onClick={onOpen}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onOpen();
				}
			}}
			className="flex cursor-pointer flex-col rounded-lg border border-rule bg-sheet p-4 transition-colors hover:border-rule-strong focus-visible:border-primary"
		>
			<div className="flex items-baseline gap-2">
				<h2 className="min-w-0 truncate text-[17px] font-semibold">{project.name}</h2>
				<span className="ml-auto shrink-0 font-mono text-[12px] text-slate">{project.defaultBranch}</span>
			</div>
			<p className="mt-0.5 truncate font-mono text-[12px] text-slate" title={project.repoPath}>
				{project.repoPath}
			</p>

			<div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
				<span className="chip">{open} open</span>
				{cards.length === 0 && <span className="chip">No cards yet</span>}
			</div>

			<dl className="mt-3 grid gap-1 border-t border-rule pt-3 text-[13px]">
				<div className="flex items-baseline gap-2">
					<dt className="w-14 shrink-0 text-slate">Verify</dt>
					<dd className="min-w-0 flex-1 truncate text-right">
						{project.verifyCommand ? (
							<code className="font-mono text-[12px]" title={project.verifyCommand}>
								{project.verifyCommand}
							</code>
						) : (
							<span className="text-caution-text">not set</span>
						)}
					</dd>
				</div>
				{project.setupCommand && (
					<div className="flex items-baseline gap-2">
						<dt className="w-14 shrink-0 text-slate">Setup</dt>
						<dd className="min-w-0 flex-1 truncate text-right font-mono text-[12px]" title={project.setupCommand}>
							{project.setupCommand}
						</dd>
					</div>
				)}
				<div className="flex items-baseline gap-2">
					<dt className="w-14 shrink-0 text-slate">Reviews</dt>
					<dd className="min-w-0 flex-1 truncate text-right">{reviewCount === null || reviewCount === undefined ? "Tower's default set" : reviewCount === 0 ? "none" : `${reviewCount} flow${reviewCount === 1 ? "" : "s"}`}</dd>
				</div>
				{spend !== undefined && (
					<div className="flex items-baseline gap-2">
						<dt className="w-14 shrink-0 text-slate">Spent</dt>
						<dd className="min-w-0 flex-1 truncate text-right tnum">
							{formatTokens(spend.tokens)}
							{spend.costUsd > 0 && ` · $${spend.costUsd.toFixed(2)}`}
						</dd>
					</div>
				)}
			</dl>

			<div className="mt-3 flex items-center gap-2 border-t border-rule pt-3">
				<button
					type="button"
					className="btn sm"
					onClick={(event) => {
						event.stopPropagation();
						onAddWork();
					}}
				>
					<Icon name="plus" />
					Add card
				</button>
				<button
					type="button"
					className="btn sm"
					title="Cut a plan into backlog cards"
					onClick={(event) => {
						event.stopPropagation();
						onPlanToBacklog();
					}}
				>
					<Icon name="spark" />
					Plan to backlog
				</button>
				<span className="ml-auto flex items-center gap-1 text-[13px] font-semibold text-primary">
					Settings
					<Icon name="chev-r" className="icon" />
				</span>
			</div>
		</li>
	);
}
