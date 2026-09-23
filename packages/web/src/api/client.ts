import type { Card, Project, StageRun } from "@tower/core";

export interface Board {
	projects: Project[];
	cards: Card[];
	activeRuns: StageRun[];
}

export interface Artifact {
	name: string;
	bytes: number;
	modifiedAt: number;
}

export interface Gate {
	id: string;
	kind: "plan_approval" | "feedback";
	status: "pending" | "approved" | "rejected";
	feedback: string | null;
}

/** The dev-server preview of a card, if one is running. In-memory state; it does not survive a daemon restart. */
export interface Preview {
	running: boolean;
	command: string | null;
	url: string | null;
	startedAt: number | null;
}

export interface CardDetail {
	card: Card;
	runs: StageRun[];
	gates: Gate[];
	artifacts: Artifact[];
	bench: { preview: Preview };
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
	maxCrew: number;
	feedbackRepo: string;
}

export interface FlowInfo {
	name: string;
	title: string;
	description: string;
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

export interface FiledFeedback {
	repo: string;
	number: number;
	url: string;
}

export type FeedbackKind = "bug" | "feature" | "feedback";

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
	usage: () => request<Usage>("GET", "/api/usage"),
	adhoc: (cardId: string, body: Record<string, string | undefined>) => request<{ run: StageRun }>("POST", `/api/cards/${cardId}/adhoc`, body),
	checkPr: (cardId: string) => request<Card>("POST", `/api/cards/${cardId}/check-pr`),
	answerUi: (runId: string, requestId: string, answer: Record<string, unknown>) => request<{ ok: true }>("POST", `/api/runs/${runId}/ui/${requestId}`, answer),
	settings: () => request<Settings>("GET", "/api/settings"),
	saveSettings: (models: Record<string, { model: string; thinking: string } | null>) => request<Settings>("PUT", "/api/settings", { models }),
	addProject: (repoPath: string) => request<Project>("POST", "/api/projects", { repoPath }),
	resume: (cardId: string) => request<Card>("POST", `/api/cards/${cardId}/resume`),
	updateProject: (id: string, settings: { setupCommand: string; verifyCommand: string; testCommand: string; previewCommand: string; previewUrl: string; concurrencyLimit: number; reviewFlows: string[] | null; invariantSimulation: boolean | null; subagents: boolean | null }) => request<Project>("PATCH", `/api/projects/${id}`, settings),
	addCard: (projectId: string, title: string, brief: string) => request<Card>("POST", "/api/cards", { projectId, title, brief }),
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
	decideGate: (cardId: string, gateId: string, decision: "approve" | "reject", feedback?: string) =>
		request<Card>("POST", `/api/cards/${cardId}/gates/${gateId}`, { decision, feedback }),
	steer: (cardId: string, text: string) => request<{ ok: true }>("POST", `/api/cards/${cardId}/steer`, { text }),
	abort: (cardId: string) => request<{ ok: true }>("POST", `/api/cards/${cardId}/abort`),
	runTests: (cardId: string) => request<{ run: StageRun }>("POST", `/api/cards/${cardId}/test`),
	startPreview: (cardId: string) => request<Preview>("POST", `/api/cards/${cardId}/preview`),
	stopPreview: (cardId: string) => request<Preview>("DELETE", `/api/cards/${cardId}/preview`),
};
