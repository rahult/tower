import type { Project, ResearchQuestion } from "@tower/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { Modal } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { Markdown } from "../content/Markdown.tsx";
import { toast } from "../app/toasts.tsx";
import { field } from "../ui.ts";

/**
 * The Research lane: a question asked before any project exists. A survey gathers evidence (and
 * probes with spike code when reading cannot settle it), a synthesizer writes the cited brief, and
 * the brief waits here — promotion, the person's decision, files it as a card in the project they
 * pick, where the planner reads it like any research brief.
 */
export function Research({ projects, onOpenCard }: { projects: Project[]; onOpenCard: (cardId: string) => void }) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState("");
	const [promoting, setPromoting] = useState<ResearchQuestion | null>(null);

	const ask = useMutation({
		mutationFn: () => api.askResearch(draft.trim()),
		onSuccess: () => {
			setDraft("");
			void queryClient.invalidateQueries({ queryKey: ["board", "research"] });
			toast("Researching — the survey runs first, then the cited brief lands here.");
		},
		onError: (error: Error) => toast(error.message),
	});
	const rerun = useMutation({
		mutationFn: (id: string) => api.runResearch(id),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board", "research"] }),
	});

	return (
		<div className="mx-auto w-full max-w-2xl px-4 py-6">
			<header className="mb-4">
				<h1 className="text-[22px] font-semibold tracking-tight">Research</h1>
				<p className="mt-1 text-[14px] text-slate">A question does not need a project yet. Ask it here: a survey fetches the evidence — probing with spike code when reading cannot settle it — and a synthesizer writes a cited brief. Promote the brief to a card when a project deserves it.</p>
			</header>
			<form
				className="grid gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (!ask.isPending && draft.trim()) ask.mutate();
				}}
			>
				<textarea
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					rows={2}
					placeholder="Local-first sync for a notes app — CRDT, event log, or last-write-wins?"
					className={`${field} resize-y`}
					aria-label="Your research question"
				/>
				<div className="flex justify-end">
					<button type="submit" className="btn primary" disabled={ask.isPending || draft.trim().length < 8}>
						<Icon name="spark" />
						{ask.isPending ? "Filing…" : "Research it"}
					</button>
				</div>
			</form>

			<ul className="mt-5 grid gap-3">
				<ResearchList onPromote={setPromoting} onRerun={(id) => rerun.mutate(id)} onOpenCard={onOpenCard} />
			</ul>

			{promoting && <PromoteDialog question={promoting} projects={projects} onClose={() => setPromoting(null)} onOpenCard={onOpenCard} />}
		</div>
	);
}

const STATUS: Record<ResearchQuestion["status"], { label: string; className: string }> = {
	open: { label: "Unanswered", className: "bg-wash text-slate" },
	running: { label: "Researching…", className: "bg-primary-soft text-primary" },
	brief: { label: "Brief ready", className: "bg-ok-soft text-ok" },
	promoted: { label: "Promoted", className: "bg-wash text-slate" },
};

function ResearchList({ onPromote, onRerun, onOpenCard }: { onPromote: (question: ResearchQuestion) => void; onRerun: (id: string) => void; onOpenCard: (cardId: string) => void }) {
	// The lane refetches with the board (SSE chatter and research events alike), so a running
	// question's steps land without a manual refresh.
	const research = useQuery({ queryKey: ["board", "research"], queryFn: api.research, refetchInterval: (query) => (query.state.data?.questions.some((question) => question.status === "running") ? 2500 : false) });
	const questions = research.data?.questions ?? [];
	if (questions.length === 0) {
		return (
			<li className="rounded-lg border border-rule bg-wash/40 p-6 text-center text-[14px] text-slate">
				No questions yet. The first one is usually the one you have been avoiding.
			</li>
		);
	}
	return <QuestionRows questions={questions} onPromote={onPromote} onRerun={onRerun} onOpenCard={onOpenCard} />;
}

function QuestionRows({ questions, onPromote, onRerun, onOpenCard }: { questions: ResearchQuestion[]; onPromote: (question: ResearchQuestion) => void; onRerun: (id: string) => void; onOpenCard: (cardId: string) => void }) {
	return (
		<>
			{questions.map((question) => (
				<li key={question.id} className="rounded-lg border border-rule bg-sheet p-4">
					<div className="flex items-start justify-between gap-3">
						<p className="min-w-0 text-[15px] font-medium">{question.question}</p>
						<span className={`shrink-0 rounded px-1.5 py-0.5 text-[12px] font-medium ${STATUS[question.status].className}`}>{STATUS[question.status].label}</span>
					</div>
					{question.brief && (
						<details className="mt-2">
							<summary className="cursor-pointer select-none text-[13px] text-primary">Read the brief</summary>
							<div className="mt-2 max-h-96 overflow-y-auto rounded-md border border-rule bg-wash/40 p-3 text-[13.5px]">
								<Markdown text={question.brief} />
							</div>
						</details>
					)}
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{question.status === "brief" && (
							<button type="button" className="btn primary" onClick={() => onPromote(question)}>
								Promote to a card…
							</button>
						)}
						{question.status === "open" && (
							<button type="button" className="btn" onClick={() => onRerun(question.id)}>
								Try again
							</button>
						)}
						{question.status === "running" && <span className="text-[13px] text-slate">The survey is gathering evidence — the brief follows.</span>}
						{question.status === "promoted" && (
							<button type="button" className="btn ghost" onClick={() => onOpenCard(question.promotedCardId as string)}>
								Open the card
							</button>
						)}
					</div>
				</li>
			))}
		</>
	);
}

function PromoteDialog({ question, projects, onClose, onOpenCard }: { question: ResearchQuestion; projects: Project[]; onClose: () => void; onOpenCard: (cardId: string) => void }) {
	const queryClient = useQueryClient();
	const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
	const [title, setTitle] = useState("");
	const promote = useMutation({
		mutationFn: () => api.promoteResearch(question.id, projectId, title.trim() || undefined),
		onSuccess: ({ card }) => {
			void queryClient.invalidateQueries({ queryKey: ["board", "research"] });
			void queryClient.invalidateQueries({ queryKey: ["board"] });
			toast(`Promoted to ${card.title} — the planner reads the brief.`);
			onClose();
			onOpenCard(card.id);
		},
		onError: (error: Error) => toast(error.message),
	});

	return (
		<Modal title="Promote the brief to a card" onClose={onClose}>
			<p className="meta">The brief becomes this card's research file, and its planner reads it first — the exploration flows into the plan without a copy-paste.</p>
			<form
				className="grid gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (!promote.isPending && projectId) promote.mutate();
				}}
			>
				<div className="field">
					<label htmlFor="promote-project">Project</label>
					<select id="promote-project" value={projectId} onChange={(event) => setProjectId(event.target.value)} className={field}>
						{projects.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name}
							</option>
						))}
					</select>
					{projects.length === 0 && <span className="hint">No projects yet — add one first, then promote.</span>}
				</div>
				<div className="field">
					<label htmlFor="promote-title">Card title</label>
					<input id="promote-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`Research: ${question.question.slice(0, 70)}`} className={field} />
					<span className="hint">Blank uses the question itself.</span>
				</div>
				<div className="acts !justify-between">
					<button type="button" className="btn ghost" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={!projectId || promote.isPending}>
						{promote.isPending ? "Filing…" : "File the card"}
					</button>
				</div>
			</form>
		</Modal>
	);
}
