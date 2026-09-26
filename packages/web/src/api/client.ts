import type { Annotation, Card, Project, ResearchQuestion, StageRun } from "@tower/core";

/** A human decision the pipeline is parked on, as the board payload carries it. */
export interface GateInfo {
	id: string;
	cardId: string;
	kind: "plan_approval" | "feedback" | "budget";
	status: "pending" | "approved" | "rejected";
	createdAt: number;
}

export interface Board {
	projects: Project[];
	cards: Card[];
	activeRuns: StageRun[];
	gates: GateInfo[];
}

export interface Artifact {
	name: string;
	bytes: number;
	modifiedAt: number;
}

export interface Gate {
	id: string;
	kind: "plan_approval" | "feedback" | "budget";
	status: "pending" | "approved" | "rejected";
	feedback: string | null;
}

/** The dev-server preview of a card, if one is running. In-memory state; it does not survive a daemon restart. */
export interface Preview {
	running: boolean;
	command: string | null;
	url: string | null;
	startedAt: number | null;
	/** The project's preview check, run after start: proof the URL is really this app. null when no check is configured. */
	check: { status: "running" | "passed" | "failed"; output: string | null } | null;
}

export interface CardDetail {
	card: Card;
	runs: StageRun[];
	gates: Gate[];
	artifacts: Artifact[];
	annotations: Annotation[];
	bench: { preview: Preview };
	/** The card's spend and the project's per-card budget, so the drawer can meter while it runs. */
	spend: { spentUsd: number; budgetUsd: number | null };
}

export interface StageModel {
	model: string;
	thinking: string;
	source: "config" | "default";
}

export interface Settings {
	models: Record<"planning" | "building" | "testing", StageModel>;
	file: string;
	knownModels: string[];
	invariantSimulation: boolean;
	subagents: boolean;
	understandBeforePlan: boolean;
	acceptanceGates: boolean;
	maxCrew: number;
	feedbackRepo: string;
}

/** The verdict of one probed model: a tiny real session, the provider's own words when it fails. */
export interface ModelCheck {
	model: string;
	ok: boolean;
	error: string | null;
	ms: number;
}

export interface FlowInfo {
	name: string;
	title: string;
	description: string;
	/** When the flow runs: manual, and any lifecycle hooks it has attached itself to. */
	when: string[];
}

export interface UsageRow {
	key: string;
	runs: number;
	tokens: number;
	costUsd: number;
}

export interface Usage {
	byDay: UsageRow[];
	byProject: UsageRow[];
	byModel: UsageRow[];
	byCard: UsageRow[];
}

export interface CardDiff {
	diff: string;
	untracked: string[];
}

/** One proposed backlog card, cut from a plan by the work-breakdown agent. */
export interface PlanCard {
	title: string;
	brief: string;
}

/** What the agent drafted for a project's commands; any field may be null when it is not applicable. */
export interface CommandSuggestions {
	verify: string | null;
	test: string | null;
	setup: string | null;
	previewCommand: string | null;
	previewUrl: string | null;
}

/** One directory in the add-project picker, flagged when it looks like a git repository. */
export interface DirEntry {
	name: string;
	path: string;
	git: boolean;
}

export interface DirListing {
	path: string;
	parent: string;
	dirs: DirEntry[];
}

export interface FiledFeedback {
	repo: string;
	number: number;
	url: string;
}

export type FeedbackKind = "bug" | "feature" | "feedback";

export type AssistOutcome = {
	ok: boolean;
	action?: "add_card" | "start_card" | "research_card" | "new_project";
	card?: Pick<Card, "id" | "title" | "stage" | "status">;
	projectId?: string;
	reply: string;
};

/** An archetype: the named engineering baseline a project can be scaffolded from. */
export interface Archetype {
	name: string;
	title: string;
	description: string;
}

export interface FromIdeaResult {
	project: Project;
	card: Card;
}

/** How a project's system model relates to the code as it stands. */
export interface ProjectModel {
	state: "missing" | "fresh" | "stale";
	commit: string | null;
	builtAt: number | null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	const json = response.headers.get("content-type")?.includes("json");
	if (!response.ok) throw new Error(json ? JSON.parse(text).error : text || response.statusText);
	return (json ? JSON.parse(text) : text) as T;
}

export const api = {
	board: () => request<Board>("GET", "/api/board"),
	card: (id: string) => request<CardDetail>("GET", `/api/cards/${id}`),
	artifact: (cardId: string, name: string) => request<string>("GET", `/api/cards/${cardId}/artifacts/${encodeURIComponent(name)}`),
	flows: () => request<{ flows: FlowInfo[]; defaults: string[] }>("GET", "/api/flows"),
	dirList: (path?: string) => request<DirListing>("GET", `/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
	suggestCommands: (projectId: string) => request<CommandSuggestions>("POST", `/api/projects/${projectId}/suggest-commands`),
	planToBacklog: (projectId: string, body: { plan?: string; cardId?: string }) => request<{ cards: PlanCard[] }>("POST", `/api/projects/${projectId}/plan-to-backlog`, body),
	filePlanCards: (projectId: string, cards: PlanCard[], queue = false) => request<{ cards: Card[] }>("POST", `/api/projects/${projectId}/plan-to-backlog/file`, { cards, ...(queue ? { queue: true } : {}) }),
	research: () => request<{ questions: ResearchQuestion[] }>("GET", "/api/research"),
	askResearch: (question: string) => request<{ question: ResearchQuestion }>("POST", "/api/research", { question }),
	runResearch: (id: string) => request<{ ok: true }>("POST", `/api/research/${id}/run`),
	promoteResearch: (id: string, projectId: string, title?: string) => request<{ card: Card }>("POST", `/api/research/${id}/promote`, { projectId, ...(title ? { title } : {}) }),
	usage: () => request<Usage>("GET", "/api/usage"),
	adhoc: (cardId: string, body: Record<string, string | undefined>) => request<{ run: StageRun }>("POST", `/api/cards/${cardId}/adhoc`, body),
	addAnnotation: (cardId: string, body: { artifact: string; quote: string; note: string }) =>
		request<{ annotation: Annotation; annotations: Annotation[] }>("POST", `/api/cards/${cardId}/annotations`, body),
	setAnnotation: (cardId: string, annotationId: string, resolved: boolean) =>
		request<{ annotations: Annotation[] }>("PATCH", `/api/cards/${cardId}/annotations/${annotationId}`, { resolved }),
	deleteAnnotation: (cardId: string, annotationId: string) => request<{ annotations: Annotation[] }>("DELETE", `/api/cards/${cardId}/annotations/${annotationId}`),
	checkPr: (cardId: string) => request<Card>("POST", `/api/cards/${cardId}/check-pr`),
	answerUi: (runId: string, requestId: string, answer: Record<string, unknown>) => request<{ ok: true }>("POST", `/api/runs/${runId}/ui/${requestId}`, answer),
	settings: () => request<Settings>("GET", "/api/settings"),
	saveSettings: (models: Record<string, { model: string; thinking: string } | null>) => request<Settings>("PUT", "/api/settings", { models }),
	checkModels: (models: string[]) => request<{ checks: ModelCheck[] }>("POST", "/api/settings/check-models", { models }),
	addProject: (repoPath: string) => request<Project>("POST", "/api/projects", { repoPath }),
	archetypes: () => request<{ archetypes: Archetype[] }>("GET", "/api/archetypes"),
	fromIdea: (body: { name: string; idea: string; archetype: string }) => request<FromIdeaResult>("POST", "/api/projects/from-idea", body),
	projectModel: (id: string) => request<ProjectModel>("GET", `/api/projects/${id}/model`),
	understand: (id: string) => request<Card>("POST", `/api/projects/${id}/understand`),
	resume: (cardId: string) => request<Card>("POST", `/api/cards/${cardId}/resume`),
	deleteCard: (cardId: string) => request<{ ok: true }>("DELETE", `/api/cards/${cardId}`),
	updateProject: (id: string, settings: { setupCommand: string; verifyCommand: string; testCommand: string; previewCommand: string; previewUrl: string; previewCheck: string; budgetUsd: number | null; parallelReviews: boolean | null; concurrencyLimit: number; reviewFlows: string[] | null; invariantSimulation: boolean | null; subagents: boolean | null; understandBeforePlan: boolean | null; acceptanceGates: boolean | null; sources: string[] }) => request<Project>("PATCH", `/api/projects/${id}`, settings),
	addCard: (projectId: string, title: string, brief: string, baseCardId?: string, dependsOn?: string) =>
		request<Card>("POST", "/api/cards", { projectId, title, brief, ...(baseCardId ? { baseCardId } : {}), ...(dependsOn ? { dependsOn } : {}) }),
	assist: (text: string) => request<AssistOutcome>("POST", "/api/assist", { text }),
	fileFeedback: async (body: { kind: FeedbackKind; title: string; details: string; includeDiagnostics: boolean }): Promise<FiledFeedback> => {
		// A 503 carries a prefilled GitHub issue form alongside the error, which the modal offers as the way out.
		const response = await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const json = (await response.json()) as Partial<FiledFeedback> & { error?: string; fallback?: string };
		if (!response.ok) throw Object.assign(new Error(json.error ?? "Filing the issue failed"), { fallback: json.fallback });
		return json as FiledFeedback;
	},
	diff: (cardId: string) => request<CardDiff>("GET", `/api/cards/${cardId}/diff`),
	enqueue: (cardId: string) => request<Card>("POST", `/api/cards/${cardId}/enqueue`),
	answer: (cardId: string, answers: Array<{ question: string; answer: string }>) => request<Card>("POST", `/api/cards/${cardId}/answers`, { answers }),
	retry: (cardId: string, feedback?: string) => request<Card>("POST", `/api/cards/${cardId}/retry`, { feedback }),
	decideGate: (cardId: string, gateId: string, decision: "approve" | "reject", feedback?: string, acknowledgeBlocking?: boolean) =>
		request<Card>("POST", `/api/cards/${cardId}/gates/${gateId}`, { decision, feedback, ...(acknowledgeBlocking ? { acknowledgeBlocking: true } : {}) }),
	steer: (cardId: string, text: string) => request<{ ok: true }>("POST", `/api/cards/${cardId}/steer`, { text }),
	abort: (cardId: string) => request<{ ok: true }>("POST", `/api/cards/${cardId}/abort`),
	runTests: (cardId: string) => request<{ run: StageRun }>("POST", `/api/cards/${cardId}/test`),
	startPreview: (cardId: string) => request<Preview>("POST", `/api/cards/${cardId}/preview`),
	stopPreview: (cardId: string) => request<Preview>("DELETE", `/api/cards/${cardId}/preview`),
};
