import type { Card, Project, StageRun } from "@traffic-control/core";

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

export interface CardDetail {
	card: Card;
	runs: StageRun[];
	artifacts: Artifact[];
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
	addCard: (projectId: string, title: string, brief: string) => request<Card>("POST", "/api/cards", { projectId, title, brief }),
	runPlanning: (cardId: string) => request<StageRun>("POST", `/api/cards/${cardId}/run`, { stage: "planning" }),
	steer: (cardId: string, text: string) => request<{ ok: true }>("POST", `/api/cards/${cardId}/steer`, { text }),
	abort: (cardId: string) => request<{ ok: true }>("POST", `/api/cards/${cardId}/abort`),
};
