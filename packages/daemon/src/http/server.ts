import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentStage, Card, Project } from "@traffic-control/core";
import { Hono } from "hono";
import { type Config, paths } from "../config.ts";
import type { Db } from "../db/open.ts";
import { getCard, insertCard, listCards } from "../db/repo-cards.ts";
import { getProject, insertProject, listProjects } from "../db/repo-projects.ts";
import { listActiveRuns, listRunsForCard } from "../db/repo-runs.ts";
import type { Bus } from "../events/bus.ts";
import { handleStream } from "../events/sse.ts";
import { detectDefaultBranch, isGitRepo } from "../git/worktree-manager.ts";
import type { RunManager } from "../run/run-manager.ts";
import type { StageRunner } from "../stage-runner.ts";
import { serveWeb } from "./static.ts";

export interface AppDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
	stages: StageRunner;
}

class HttpError extends Error {
	readonly status: 400 | 404 | 409;
	constructor(status: 400 | 404 | 409, message: string) {
		super(message);
		this.status = status;
	}
}

const shortId = () => randomUUID().replaceAll("-", "").slice(0, 8);

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `"${key}" is required`);
	return value.trim();
}

export function createApp(deps: AppDeps): Hono {
	const { config, db, bus, runs, stages } = deps;
	const app = new Hono();

	app.onError((error, c) => {
		if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
		console.error(error);
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
	});

	const cardOr404 = (id: string): Card => {
		const card = getCard(db, id);
		if (!card) throw new HttpError(404, `Card not found: ${id}`);
		return card;
	};

	app.get("/api/health", (c) => c.json({ ok: true }));

	app.get("/api/board", (c) => c.json({ projects: listProjects(db), cards: listCards(db), activeRuns: listActiveRuns(db) }));

	app.post("/api/projects", async (c) => {
		const body = (await c.req.json()) as Record<string, unknown>;
		const repoPath = resolve(requireString(body, "repoPath"));
		if (!(await isGitRepo(repoPath))) throw new HttpError(400, `Not a git repository: ${repoPath}`);
		if (listProjects(db).some((p) => p.repoPath === repoPath)) throw new HttpError(409, "This repository is already a project");
		const project: Project = {
			id: shortId(),
			name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : basename(repoPath),
			repoPath,
			defaultBranch: await detectDefaultBranch(repoPath),
			setupCommand: null,
			verifyCommand: null,
			trustProjectPi: false,
			extensions: [],
			concurrencyLimit: 1,
			stageConfig: {},
			createdAt: Date.now(),
		};
		insertProject(db, project);
		bus.publish({ topic: "board", type: "project_upserted", data: project });
		return c.json(project, 201);
	});

	app.post("/api/cards", async (c) => {
		const body = (await c.req.json()) as Record<string, unknown>;
		const projectId = requireString(body, "projectId");
		if (!getProject(db, projectId)) throw new HttpError(404, `Project not found: ${projectId}`);
		const now = Date.now();
		const card: Card = {
			id: shortId(),
			projectId,
			title: requireString(body, "title"),
			brief: typeof body.brief === "string" ? body.brief : "",
			stage: "backlog",
			status: "idle",
			priority: 0,
			position: now,
			branchName: null,
			worktreePath: null,
			baseCommit: null,
			attempt: 0,
			stageConfig: typeof body.stageConfig === "object" && body.stageConfig !== null ? (body.stageConfig as Card["stageConfig"]) : {},
			prUrl: null,
			prState: null,
			needsAttentionReason: null,
			createdAt: now,
			updatedAt: now,
		};
		insertCard(db, card);
		bus.publish({ topic: "board", type: "card_upserted", data: card });
		return c.json(card, 201);
	});

	app.get("/api/cards/:id", (c) => {
		const card = cardOr404(c.req.param("id"));
		return c.json({ card, runs: listRunsForCard(db, card.id), artifacts: listArtifacts(config, card.id) });
	});

	// M1: run a single stage directly. M2 replaces this with enqueue + the card state machine.
	app.post("/api/cards/:id/run", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const stage = (body.stage ?? "planning") as AgentStage;
		if (stage !== "planning") throw new HttpError(400, "Only the planning stage can be run in this milestone");
		if (runs.liveRunForCard(card.id)) throw new HttpError(409, "This card already has a running session");
		const feedback = typeof body.feedback === "string" ? body.feedback : undefined;
		return c.json(await stages.start(card.id, stage, feedback ? { feedback } : {}), 202);
	});

	app.post("/api/cards/:id/steer", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const text = requireString((await c.req.json()) as Record<string, unknown>, "text");
		if (!runs.liveRunForCard(card.id)) throw new HttpError(409, "This card has no running session to steer");
		await stages.steer(card.id, text);
		return c.json({ ok: true });
	});

	app.post("/api/cards/:id/abort", async (c) => {
		const card = cardOr404(c.req.param("id"));
		if (!runs.liveRunForCard(card.id)) throw new HttpError(409, "This card has no running session to abort");
		await stages.abort(card.id);
		return c.json({ ok: true });
	});

	app.get("/api/cards/:id/artifacts/:name", (c) => {
		const card = cardOr404(c.req.param("id"));
		const name = c.req.param("name");
		const file = join(paths.cardDir(config, card.id), name);
		// basename check: artifact names never contain path separators, so this blocks traversal.
		if (basename(name) !== name || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, `Artifact not found: ${name}`);
		return c.text(readFileSync(file, "utf8"));
	});

	app.get("/api/runs/:id/transcript", (c) => c.json(runs.transcript(c.req.param("id"), Number(c.req.query("since") ?? 0))));

	app.get("/api/stream", (c) => handleStream(c, bus, runs));

	app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
	app.get("*", (c) => serveWeb(c, config.webDist));

	return app;
}

function listArtifacts(config: Config, cardId: string): Array<{ name: string; bytes: number; modifiedAt: number }> {
	const dir = paths.cardDir(config, cardId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const stat = statSync(join(dir, entry.name));
			return { name: entry.name, bytes: stat.size, modifiedAt: stat.mtimeMs };
		});
}
