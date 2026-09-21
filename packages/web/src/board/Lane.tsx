import type { Card, Project } from "@tower/core";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { button, field, monoField } from "../ui.ts";
import { Strip, StripButton } from "./Strip.tsx";
import { STAGE_COLUMNS } from "./status.ts";

interface LaneProps {
	project: Project;
	cards: Card[];
	selectedCardId: string | null;
	onOpen: (cardId: string) => void;
	last: boolean;
}

/** A project's swimlane: its header cell, then one cell per stage holding that stage's strips. Renders grid cells only. */
export function Lane({ project, cards, selectedCardId, onOpen, last }: LaneProps) {
	const [adding, setAdding] = useState(false);
	const [configuring, setConfiguring] = useState(false);
	const open = (card: Card) => onOpen(card.id);
	const start = useMutation({ mutationFn: api.enqueue, onSuccess: open });
	const retry = useMutation({ mutationFn: (cardId: string) => api.retry(cardId), onSuccess: open });
	const resume = useMutation({ mutationFn: api.resume, onSuccess: open });
	const abort = useMutation({ mutationFn: api.abort });
	const failure = start.error ?? retry.error ?? resume.error ?? abort.error;
	const edge = last ? "" : "border-b";

	const actionFor = (card: Card) => {
		if (card.status === "running" || card.status === "verifying" || card.status === "queued") {
			return (
				<StripButton onClick={() => abort.mutate(card.id)} disabled={abort.isPending} kind="danger">
					{card.status === "queued" ? "Remove from queue" : "Abort"}
				</StripButton>
			);
		}
		if (card.stage === "backlog") {
			return (
				<StripButton onClick={() => start.mutate(card.id)} disabled={start.isPending} kind="primary">
					Start
				</StripButton>
			);
		}
		if (card.status === "awaiting_gate") {
			return (
				<StripButton onClick={() => onOpen(card.id)} kind="onCaution">
					Review plan
				</StripButton>
			);
		}
		if (card.status === "awaiting_input") {
			return (
				<StripButton onClick={() => onOpen(card.id)} kind="onCaution">
					Answer
				</StripButton>
			);
		}
		if (card.status === "interrupted") {
			return (
				<StripButton onClick={() => resume.mutate(card.id)} disabled={resume.isPending} kind="onCaution">
					Resume
				</StripButton>
			);
		}
		if (card.status === "needs_attention" || card.status === "idle") {
			return (
				<StripButton onClick={() => retry.mutate(card.id)} disabled={retry.isPending} kind={card.status === "needs_attention" ? "onCaution" : "quiet"}>
					Run again
				</StripButton>
			);
		}
		return null;
	};

	return (
		<>
			<header className={`sticky left-0 z-10 flex flex-col gap-1 border-rule bg-sheet p-3 ${edge}`}>
				<h2 className="text-[15px] leading-tight font-bold">{project.name}</h2>
				<p className="truncate font-mono text-[11px] text-slate" title={`${project.repoPath} on ${project.defaultBranch}`}>
					{project.defaultBranch}
				</p>
				<p className="text-[12px] leading-snug text-slate">{project.verifyCommand ? "Your verify command judges builds" : "No verify command, so an agent judges builds"}</p>
				<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
					<button type="button" onClick={() => setAdding((on) => !on)} className={button.link}>
						{adding ? "Cancel" : "Add card"}
					</button>
					<button type="button" onClick={() => setConfiguring((on) => !on)} className={button.link}>
						{configuring ? "Close settings" : "Settings"}
					</button>
				</div>
				{failure && <p className="rounded bg-danger-soft px-2 py-1 text-[13px] text-danger">{failure.message}</p>}
			</header>

			{configuring ? (
				<div className={`col-span-7 border-l border-rule bg-wash p-4 ${edge}`}>
					<ProjectSettings project={project} onDone={() => setConfiguring(false)} />
				</div>
			) : (
				STAGE_COLUMNS.map(({ stage, label }) => {
					const inStage = cards.filter((card) => card.stage === stage);
					return (
						<section key={stage} aria-label={`${project.name}, ${label}`} className={`@container min-h-24 border-l border-rule bg-wash p-1.5 ${edge}`}>
							{stage === "backlog" && adding && <NewCard projectId={project.id} onDone={() => setAdding(false)} />}
							<ul className="flex flex-col gap-1.5">
								{inStage.map((card) => (
									<Strip key={card.id} card={card} selected={card.id === selectedCardId} onOpen={() => onOpen(card.id)} action={actionFor(card)} />
								))}
							</ul>
						</section>
					);
				})
			)}
		</>
	);
}

function ProjectSettings({ project, onDone }: { project: Project; onDone: () => void }) {
	const [setupCommand, setSetupCommand] = useState(project.setupCommand ?? "");
	const [verifyCommand, setVerifyCommand] = useState(project.verifyCommand ?? "");
	const [concurrencyLimit, setConcurrencyLimit] = useState(project.concurrencyLimit);
	const save = useMutation({ mutationFn: () => api.updateProject(project.id, { setupCommand, verifyCommand, concurrencyLimit }), onSuccess: onDone });
	return (
		<form
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				save.mutate();
			}}
			className="flex max-w-[60ch] flex-col gap-4"
		>
			<label className="block font-semibold">
				Verify command
				<span className="block text-[13px] font-normal text-slate">Runs in the card's worktree after each build. Its exit code decides whether testing passes; failures go back to the builder.</span>
				<input value={verifyCommand} onChange={(event) => setVerifyCommand(event.target.value)} placeholder="pnpm test && pnpm typecheck" className={`mt-1 ${monoField}`} />
			</label>
			<label className="block font-semibold">
				Setup command
				<span className="block text-[13px] font-normal text-slate">Runs once when a card's worktree is created. New worktrees have no installed dependencies.</span>
				<input value={setupCommand} onChange={(event) => setSetupCommand(event.target.value)} placeholder="pnpm install --prefer-offline" className={`mt-1 ${monoField}`} />
			</label>
			<label className="block font-semibold">
				Cards at once
				<span className="block text-[13px] font-normal text-slate">How many of this project's cards may run at the same time. Each runs in its own worktree.</span>
				<input type="number" min={1} max={16} value={concurrencyLimit} onChange={(event) => setConcurrencyLimit(Number(event.target.value))} className={`mt-1 !w-24 ${monoField}`} />
			</label>
			<div className="flex items-center gap-3">
				<button type="submit" disabled={save.isPending} className={button.primary}>
					Save settings
				</button>
				{save.error && <span className="text-[14px] text-danger">{save.error.message}</span>}
			</div>
		</form>
	);
}

function NewCard({ projectId, onDone }: { projectId: string; onDone: () => void }) {
	const [title, setTitle] = useState("");
	const [brief, setBrief] = useState("");
	const add = useMutation({ mutationFn: () => api.addCard(projectId, title, brief), onSuccess: onDone });
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (title.trim()) add.mutate();
	};
	return (
		<form onSubmit={submit} className="mb-1.5 flex flex-col gap-2 rounded-md border border-primary bg-sheet p-2.5">
			<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What should be done?" aria-label="Card title" className={`${field} font-semibold placeholder:font-normal`} />
			<textarea
				value={brief}
				onChange={(event) => setBrief(event.target.value)}
				placeholder="What the planner should know: constraints, files, what done looks like."
				aria-label="Card details"
				rows={4}
				className={`${field} resize-y text-[14px]`}
			/>
			<div className="flex items-center gap-3">
				<StripButton disabled={!title.trim() || add.isPending} kind="primary">
					Add card
				</StripButton>
				{add.error && <span className="text-[13px] text-danger">{add.error.message}</span>}
			</div>
		</form>
	);
}
