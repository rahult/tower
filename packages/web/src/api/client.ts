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

export interface CardDetail {
	card: Card;
	runs: StageRun[];
	gates: Gate[];
	artifacts: Artifact[];
}

export interface CardDiff {
	diff: string;
	untracked: string[];
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
	addProject: (repoPath: string) => request<Project>("POST", "/api/projects", { repoPath }),
	resume: (cardId: string) => request<Card>("POST", `/api/cards/${cardId}/resume`),
	updateProject: (id: string, settings: { setupCommand: string; verifyCommand: string; concurrencyLimit: number }) => request<Project>("PATCH", `/api/projects/${id}`, settings),
	addCard: (projectId: string, title: string, brief: string) => request<Card>("POST", "/api/cards", { projectId, title, brief }),
	diff: (cardId: string) => request<CardDiff>("GET", `/api/cards/${cardId}/diff`),
	enqueue: (cardId: string) => request<Card>("POST", `/api/cards/${cardId}/enqueue`),
	retry: (cardId: string, feedback?: string) => request<Card>("POST", `/api/cards/${cardId}/retry`, { feedback }),
	decideGate: (cardId: string, gateId: string, decision: "approve" | "reject", feedback?: string) =>
		request<Card>("POST", `/api/cards/${cardId}/gates/${gateId}`, { decision, feedback }),
	steer: (cardId: string, text: string) => request<{ ok: true }>("POST", `/api/cards/${cardId}/steer`, { text }),
	abort: (cardId: string) => request<{ ok: true }>("POST", `/api/cards/${cardId}/abort`),
};
