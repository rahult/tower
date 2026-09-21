import type { Card, Project } from "@tower/core";
import { useState } from "react";
import { api, type Usage } from "../api/client.ts";
import { describeCard, STAGE_LABEL } from "../board/status.ts";
import { Modal } from "../app/bits.tsx";
import { button } from "../ui.ts";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { NewProjectForm } from "../app/quickadd.tsx";

interface ProjectsProps {
	projects: Project[];
	cards: Card[];
	usage: Usage | undefined;
	onOpen: (cardId: string) => void;
	onAddWork: (projectId?: string) => void;
}

/** Every project as a health panel: what it is, what is moving on it, how it judges work, what it costs. */
export function Projects({ projects, cards, usage, onOpen, onAddWork }: ProjectsProps) {
	const [configuring, setConfiguring] = useState<Project | null>(null);
	const spend = new Map((usage?.byProject ?? []).map((row) => [row.key, row]));
	return (
		<div className="mx-auto flex w-full max-w-[70rem] flex-col gap-4">
			{projects.length === 0 ? (
				<div className="pt-6">
					<NewProjectForm first />
				</div>
			) : (
				<ul className="grid grid-cols-[repeat(auto-fill,minmax(21rem,1fr))] gap-4">
					{projects.map((project) => (
						<ProjectPanel key={project.id} project={project} cards={cards.filter((card) => card.projectId === project.id)} spend={spend.get(project.id)} onOpen={onOpen} onAddWork={onAddWork} onConfigure={() => setConfiguring(project)} />
					))}
				</ul>
			)}
			{configuring && (
				<Modal title={`${configuring.name} settings`} onClose={() => setConfiguring(null)}>
					<ProjectSettings project={configuring} onDone={() => setConfiguring(null)} />
				</Modal>
			)}
		</div>
	);
}

function ProjectPanel({ project, cards, spend, onOpen, onAddWork, onConfigure }: { project: Project; cards: Card[]; spend: { runs: number; tokens: number; costUsd: number } | undefined; onOpen: (id: string) => void; onAddWork: (projectId?: string) => void; onConfigure: () => void }) {
	const running = cards.filter((card) => card.status === "running" || card.status === "verifying").length;
	const waiting = cards.filter((card) => describeCard(card).tone === "caution").length;
	const byStage = new Map<string, number>();
	for (const card of cards) byStage.set(card.stage, (byStage.get(card.stage) ?? 0) + 1);
	const recent = cards.filter((card) => card.stage !== "done" && card.status !== "idle").slice(0, 4);
	return (
		<li className="flex flex-col rounded-lg border border-rule bg-sheet p-4">
			<div className="flex items-baseline gap-2">
				<h2 className="display min-w-0 truncate text-[19px] font-extrabold">{project.name}</h2>
				<span className="ml-auto shrink-0 font-mono text-[12px] text-slate" title={`${project.repoPath} · default branch ${project.defaultBranch}`}>
					{project.defaultBranch}
				</span>
			</div>
			<p className="truncate font-mono text-[12px] text-slate" title={project.repoPath}>
				{project.repoPath}
			</p>

			<div className="mt-3 flex flex-wrap items-center gap-1.5">
				{running > 0 && <span className="rounded bg-primary-soft px-1.5 py-px text-[12px] font-semibold text-primary">{running} running</span>}
				{waiting > 0 && <span className="rounded bg-caution-soft px-1.5 py-px text-[12px] font-semibold text-caution-text">{waiting} need you</span>}
				{[...byStage.entries()].map(([stage, count]) => (
					<span key={stage} className="rounded bg-wash px-1.5 py-px text-[12px] text-slate">
						{STAGE_LABEL[stage as Card["stage"]] ?? stage} {count}
					</span>
				))}
				{cards.length === 0 && <span className="text-[13px] text-slate">No cards yet.</span>}
			</div>

			<dl className="mt-3 flex flex-col gap-1 text-[13px]">
				<div className="flex items-baseline gap-2">
					<dt className="w-16 shrink-0 text-slate">Verify</dt>
					<dd className="min-w-0">
						{project.verifyCommand ? <code className="rounded bg-wash px-1.5 py-px font-mono text-[12px]">{project.verifyCommand}</code> : <span className="text-caution-text">not set — an agent judges builds</span>}
					</dd>
				</div>
				{project.setupCommand && (
					<div className="flex items-baseline gap-2">
						<dt className="w-16 shrink-0 text-slate">Setup</dt>
						<dd className="min-w-0 truncate">
							<code className="rounded bg-wash px-1.5 py-px font-mono text-[12px]">{project.setupCommand}</code>
						</dd>
					</div>
				)}
				<div className="flex items-baseline gap-2">
					<dt className="w-16 shrink-0 text-slate">Reviews</dt>
					<dd className="min-w-0 truncate text-ink">{project.reviewFlows?.length === 0 ? "none" : (project.reviewFlows?.join(", ").replaceAll("-", " ") ?? "Tower's default set")}</dd>
				</div>
				{spend !== undefined && (
					<div className="flex items-baseline gap-2">
						<dt className="w-16 shrink-0 text-slate">Spent</dt>
						<dd className="min-w-0">
							<span className="tnum">{formatTokens(spend.tokens)} tokens</span>
							{spend.costUsd > 0 && <span className="tnum"> · ${spend.costUsd.toFixed(2)}</span>}
							<span className="text-slate"> all time</span>
						</dd>
					</div>
				)}
			</dl>

			{recent.length > 0 && (
				<ul className="mt-3 flex flex-col gap-1 border-t border-rule pt-3">
					{recent.map((card) => (
						<li key={card.id}>
							<button type="button" onClick={() => onOpen(card.id)} className="flex w-full cursor-pointer items-baseline gap-2 truncate text-left text-[13.5px] hover:underline">
								<span aria-hidden className={`size-1.5 shrink-0 rounded-full ${describeCard(card).tone === "caution" ? "bg-caution" : describeCard(card).tone === "work" ? "bg-primary" : "bg-rule"}`} />
								<span className="min-w-0 flex-1 truncate">{card.title}</span>
							</button>
						</li>
					))}
				</ul>
			)}

			<div className="mt-3 flex flex-wrap items-center gap-3 border-t border-rule pt-3">
				<button type="button" onClick={() => onAddWork(project.id)} className={button.link}>
					Add work
				</button>
				<button type="button" onClick={onConfigure} className={button.link}>
					Settings
				</button>
			</div>
		</li>
	);
}

export function formatTokens(tokens: number): string {
	return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
