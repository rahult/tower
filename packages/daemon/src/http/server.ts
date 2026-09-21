import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type Card, InvalidTransition, type Project } from "@tower/core";
import { Hono } from "hono";
import { type Config, paths } from "../config.ts";
import type { Db } from "../db/open.ts";
import { getCard, insertCard, listCards } from "../db/repo-cards.ts";
import { getProject, insertProject, listProjects, type ProjectSettings, updateProject } from "../db/repo-projects.ts";
import { listGatesForCard } from "../db/repo-gates.ts";
import { listActiveRuns, listRunsForCard } from "../db/repo-runs.ts";
import type { Bus } from "../events/bus.ts";
import { handleStream } from "../events/sse.ts";
import { cardDiff } from "../git/diff.ts";
import { detectDefaultBranch, ensureBaseBranch, isGitRepo } from "../git/worktree-manager.ts";
import { ConflictError, type Orchestrator } from "../orchestrator.ts";
import type { RunManager } from "../run/run-manager.ts";
import { describeModels, knownModels, parseModels, SettingsError, settingsFile, writeModels } from "../settings.ts";
import type { StageRunner } from "../stage-runner.ts";
import { serveWeb } from "./static.ts";

export interface AppDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
	stages: StageRunner;
	orchestrator: Orchestrator;
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
	const { config, db, bus, runs, stages, orchestrator } = deps;
	const app = new Hono();

	app.onError((error, c) => {
		if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
		if (error instanceof SettingsError) return c.json({ error: error.message }, 400);
		if (error instanceof InvalidTransition || error instanceof ConflictError) return c.json({ error: error.message }, 409);
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

	const settingsView = () => ({ models: describeModels(config.globalStageConfig), file: settingsFile(config.home), knownModels: knownModels() });

	app.get("/api/settings", (c) => c.json(settingsView()));

	app.put("/api/settings", async (c) => {
		const body = (await c.req.json()) as { models?: unknown };
		if (body.models === undefined) throw new SettingsError('Send the "models" to use, keyed by stage: planning, building, testing');
		const models = parseModels(body.models);
		writeModels(config.home, models);
		// Sessions read this when they start, so the next stage to run uses the new models.
		config.globalStageConfig = models;
		bus.publish({ topic: "board", type: "settings_changed", data: settingsView().models });
		return c.json(settingsView());
	});

	app.post("/api/projects", async (c) => {
		const body = (await c.req.json()) as Record<string, unknown>;
		const repoPath = resolve(requireString(body, "repoPath"));
		if (!(await isGitRepo(repoPath))) throw new HttpError(400, `Not a git repository: ${repoPath}`);
		if (listProjects(db).some((p) => p.repoPath === repoPath)) throw new HttpError(409, "This repository is already a project");
		const defaultBranch = await detectDefaultBranch(repoPath);
		// A brand-new repository gets its first commit now, so its first card can start straight away.
		await ensureBaseBranch(repoPath, defaultBranch);
		const project: Project = {
			id: shortId(),
			name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : basename(repoPath),
			repoPath,
			defaultBranch,
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

	app.patch("/api/projects/:id", async (c) => {
		const id = c.req.param("id");
		if (!getProject(db, id)) throw new HttpError(404, `Project not found: ${id}`);
		const body = (await c.req.json()) as Record<string, unknown>;
		const settings: ProjectSettings = {};
		if (typeof body.name === "string" && body.name.trim()) settings.name = body.name.trim();
		// An empty string clears a command.
		for (const key of ["setupCommand", "verifyCommand"] as const) {
			if (typeof body[key] === "string") settings[key] = (body[key] as string).trim() || null;
		}
		if (body.concurrencyLimit !== undefined) {
			const limit = Number(body.concurrencyLimit);
			if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new HttpError(400, '"concurrencyLimit" must be a whole number from 1 to 16');
			settings.concurrencyLimit = limit;
		}
		const project = updateProject(db, id, settings);
		bus.publish({ topic: "board", type: "project_upserted", data: project });
		return c.json(project);
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
		return c.json({ card, runs: listRunsForCard(db, card.id), gates: listGatesForCard(db, card.id), artifacts: listArtifacts(config, card.id) });
	});

	app.post("/api/cards/:id/enqueue", (c) => c.json(orchestrator.dispatch(cardOr404(c.req.param("id")).id, { type: "enqueue" }), 202));

	app.post("/api/cards/:id/retry", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const feedback = typeof body.feedback === "string" && body.feedback.trim() ? body.feedback.trim() : undefined;
		return c.json(orchestrator.retry(card.id, feedback), 202);
	});

	app.post("/api/cards/:id/answers", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const body = (await c.req.json()) as { answers?: unknown };
		const answers = Array.isArray(body.answers) ? body.answers : [];
		const cleaned = answers
			.filter((a): a is { question: string; answer: string } => typeof a?.question === "string" && typeof a?.answer === "string")
			.map((a) => ({ question: a.question.trim(), answer: a.answer.trim() }));
		if (cleaned.length === 0 || cleaned.length !== answers.length || cleaned.some((a) => !a.question || !a.answer)) {
			throw new HttpError(400, "Send an answer for each question, as { question, answer } pairs");
		}
		return c.json(orchestrator.answer(card.id, cleaned), 202);
	});

	app.post("/api/cards/:id/resume", (c) => c.json(orchestrator.resume(cardOr404(c.req.param("id")).id), 202));

	app.post("/api/cards/:id/gates/:gateId", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const body = (await c.req.json()) as Record<string, unknown>;
		if (body.decision !== "approve" && body.decision !== "reject") throw new HttpError(400, '"decision" must be "approve" or "reject"');
		const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
		if (body.decision === "reject" && !feedback) throw new HttpError(400, "Say what should change so the planner can act on it");
		if (!listGatesForCard(db, card.id).some((gate) => gate.id === c.req.param("gateId"))) throw new HttpError(404, "Gate not found");
		return c.json(orchestrator.decideGate(card.id, c.req.param("gateId"), body.decision, feedback));
	});

	app.get("/api/cards/:id/diff", async (c) => {
		const card = cardOr404(c.req.param("id"));
		if (!card.worktreePath || !card.baseCommit) return c.json({ diff: "", untracked: [] });
		return c.json(await cardDiff(card.worktreePath, card.baseCommit));
	});

	app.post("/api/cards/:id/steer", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const text = requireString((await c.req.json()) as Record<string, unknown>, "text");
		if (!runs.liveRunForCard(card.id)?.handle) throw new HttpError(409, "This card has no running session to steer");
		await stages.steer(card.id, text);
		return c.json({ ok: true });
	});

	app.post("/api/cards/:id/abort", async (c) => {
		const card = cardOr404(c.req.param("id"));
		if (!orchestrator.isBusy(card.id)) throw new HttpError(409, "Nothing is running or queued for this card");
		await orchestrator.abort(card.id);
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
