import type { Card, Project } from "@tower/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { describeCard, STAGE_COLUMNS } from "./status.ts";
import { button, field } from "../ui.ts";
import { ProjectSettings } from "../projects/ProjectSettings.tsx";
import { Strip, StripButton } from "./Strip.tsx";

interface LaneProps {
	project: Project;
	cards: Card[];
	selectedCardId: string | null;
	onOpen: (cardId: string) => void;
	showDone: boolean;
	last: boolean;
}

/** A project's swimlane: its header cell, then one cell per stage holding that stage's strips. Renders grid cells only. */
export function Lane({ project, cards, selectedCardId, onOpen, showDone, last }: LaneProps) {
	const [adding, setAdding] = useState(false);
	const [configuring, setConfiguring] = useState(false);
	const open = (card: Card) => onOpen(card.id);
	const queryClient = useQueryClient();
	const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["board"] });
	const start = useMutation({ mutationFn: api.enqueue, onSuccess: (card) => (invalidate(), open(card)) });
	const retry = useMutation({ mutationFn: (cardId: string) => api.retry(cardId), onSuccess: (card) => (invalidate(), open(card)) });
	const resume = useMutation({ mutationFn: api.resume, onSuccess: (card) => (invalidate(), open(card)) });
	const abort = useMutation({ mutationFn: api.abort, onSuccess: invalidate });
	const checkPr = useMutation({ mutationFn: api.checkPr, onSuccess: invalidate });
	const failure = start.error ?? retry.error ?? resume.error ?? abort.error ?? checkPr.error;
	const edge = last ? "" : "border-b";
	const running = cards.filter((card) => card.status === "running" || card.status === "verifying").length;
	const waiting = cards.filter((card) => describeCard(card).tone === "caution").length;

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
					{card.stage === "feedback" ? "Review work" : "Review plan"}
				</StripButton>
			);
		}
		if (card.stage === "done") return null;
		if (card.stage === "pull_request" && card.status === "idle") {
			return (
				<StripButton onClick={() => checkPr.mutate(card.id)} disabled={checkPr.isPending}>
					Check now
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
					{card.stage === "testing" && card.status === "idle" ? "Continue" : "Run again"}
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
				{(running > 0 || waiting > 0) && (
					<p className="text-[12px] leading-snug">
						{running > 0 && <span className="font-semibold text-primary">{running} running</span>}
						{running > 0 && waiting > 0 && <span className="text-slate"> · </span>}
						{waiting > 0 && <span className="font-semibold text-caution-ink">{waiting} need you</span>}
					</p>
				)}
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
					if (stage === "done" && !showDone) {
						const done = cards.filter((card) => card.stage === "done").length;
						return (
							<section key={stage} aria-label={`${project.name}, ${label}`} className={`border-l border-rule bg-wash p-1.5 ${edge}`}>
								{done > 0 && <p className="p-2 text-[12.5px] text-slate">{done} finished — shown on Focus</p>}
							</section>
						);
					}
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
