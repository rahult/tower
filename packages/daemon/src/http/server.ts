import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { type Card, InvalidTransition, type Project } from "@tower/core";
import { Hono } from "hono";
import { type Config, paths } from "../config.ts";
import type { Db } from "../db/open.ts";
import { getCard, insertCard, listCards } from "../db/repo-cards.ts";
import { getProject, insertProject, listProjects, type ProjectSettings, updateProject } from "../db/repo-projects.ts";
import { listGatesForCard } from "../db/repo-gates.ts";
import { listActiveRuns, listRunsForCard, usageBy } from "../db/repo-runs.ts";
import type { Bus } from "../events/bus.ts";
import { handleStream } from "../events/sse.ts";
import { matchProject, readIntent, taggedProject } from "../assist.ts";
import { addAnnotation, AnnotationError, deleteAnnotation, loadAnnotations, setAnnotationResolved } from "../annotations.ts";
import { PLAN_CARDS_MAX, splitPlan } from "../plan-splitter.ts";
import { suggestCommands } from "../project-probe.ts";
import { type FeedbackKind, feedbackFallbackUrl, fileFeedback } from "../feedback.ts";
import { flowsTriggered, loadFlows, runsOnBacklogCard } from "../flows.ts";
import { listArchetypes, scaffoldFromArchetype, targetDir } from "../greenfield.ts";
import { cardDiff } from "../git/diff.ts";
import { detectDefaultBranch, ensureBaseBranch, isGitRepo } from "../git/worktree-manager.ts";
import { listRemotes } from "../pr/gh.ts";
import { ConflictError, type Orchestrator } from "../orchestrator.ts";
import { BenchError, type BenchRunner } from "../bench.ts";
import { checkModels } from "../preflight.ts";
import type { RunManager } from "../run/run-manager.ts";
import type { SessionDriver } from "../pi/session-driver.ts";
import { describeModels, knownModels, parseModels, SettingsError, settingsFile, writeModels } from "../settings.ts";
import type { StageRunner } from "../stage-runner.ts";
import { modelState } from "../system-model.ts";
import { serveWeb } from "./static.ts";

export interface AppDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
	stages: StageRunner;
	orchestrator: Orchestrator;
	bench: BenchRunner;
	/** The session seam, for one-shot sessions that belong to no card (the command box's ask). */
	driver: SessionDriver;
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
	const { config, db, bus, runs, stages, orchestrator, bench, driver } = deps;
	const app = new Hono();

	app.onError((error, c) => {
		if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
		if (error instanceof AnnotationError) return c.json({ error: error.message }, 400);
		if (error instanceof BenchError) return c.json({ error: error.message }, error.status);
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

	const settingsView = () => ({ models: describeModels(config.globalStageConfig), file: settingsFile(config.home), knownModels: knownModels(), invariantSimulation: config.invariantSimulation, subagents: config.subagents, understandBeforePlan: config.understandBeforePlan, acceptanceGates: config.acceptanceGates, maxCrew: config.maxCrew, feedbackRepo: config.feedbackRepo });

	app.get("/api/settings", (c) => c.json(settingsView()));

	// Directory listing for the board's add-project picker. The daemon runs on the user's machine, so
	// browsing happens with the daemon's own filesystem rights; only directories are returned.
	app.get("/api/fs/dirs", (c) => {
		const target = resolve(c.req.query("path")?.trim() || homedir());
		if (!existsSync(target) || !statSync(target).isDirectory()) throw new HttpError(400, `Not a directory: ${target}`);
		const dirs: Array<{ name: string; path: string; git: boolean }> = [];
		for (const entry of readdirSync(target, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			try {
				if (entry.isDirectory()) {
					const path = join(target, entry.name);
					dirs.push({ name: entry.name, path, git: existsSync(join(path, ".git")) });
				}
			} catch {
				// A directory that cannot be stat'd (permissions) is simply not offered.
			}
		}
		dirs.sort((a, b) => a.name.localeCompare(b.name));
		return c.json({ path: target, parent: resolve(target, ".."), dirs });
	});

	// Probe stage models before real work hangs on them: one tiny session each, the provider's own
	// words back when one cannot answer (no key, exhausted quota, unknown model).
	app.post("/api/settings/check-models", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { models?: unknown; timeoutMs?: unknown };
		const models = Array.isArray(body.models) ? body.models.filter((model): model is string => typeof model === "string") : [];
		if (models.length === 0) throw new HttpError(400, 'Send the "models" to check');
		const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : undefined;
		return c.json({ checks: await checkModels({ config, driver, models, timeoutMs }) });
	});

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
			testCommand: null,
			previewCommand: null,
			previewUrl: null,
			previewCheck: null,
			trustProjectPi: false,
			extensions: [],
			concurrencyLimit: 1,
			stageConfig: {},
			reviewFlows: null,
			invariantSimulation: null,
			subagents: null,
			understandBeforePlan: null,
			acceptanceGates: null,
			hasOrigin: (await listRemotes(repoPath)).includes("origin"),
			createdAt: Date.now(),
		};
		insertProject(db, project);
		bus.publish({ topic: "board", type: "project_upserted", data: project });
		return c.json(project, 201);
	});

	// An agent reads the repository and drafts the commands Tower needs, so a new project is not a
	// wall of blank fields. Suggestions are just that: the form shows them and the reader saves.
	app.post("/api/projects/:id/suggest-commands", async (c) => {
		const project = getProject(db, c.req.param("id"));
		if (!project) throw new HttpError(404, "Project not found");
		return c.json(await suggestCommands({ config, driver, repoPath: project.repoPath }));
	});

	// The archetypes a project can be scaffolded from when it starts as an idea rather than a checkout.
	app.get("/api/archetypes", (c) => c.json({ archetypes: listArchetypes(config) }));

	// How the project's system model relates to the code as it stands.
	app.get("/api/projects/:id/model", async (c) => {
		const project = getProject(db, c.req.param("id"));
		if (!project) throw new HttpError(404, "Project not found");
		const { state, meta } = await modelState(config, project.id, project.repoPath, project.defaultBranch);
		return c.json({ state, commit: meta?.commit ?? null, builtAt: meta?.builtAt ?? null });
	});

	// Understand the system: the read-only pass runs on its own card, and its report becomes the
	// project's system model — what every planner reads before planning work on this codebase.
	app.post("/api/projects/:id/understand", (c) => {
		const project = getProject(db, c.req.param("id"));
		if (!project) throw new HttpError(404, "Project not found");
		return c.json(orchestrator.understandProject(project.id), 202);
	});

	// Plan to backlog: an agent cuts a plan — pasted text, or an existing card's plan.md — into
	// proposed backlog cards. Nothing files itself: the draft comes back, the person picks, then files.
	app.post("/api/projects/:id/plan-to-backlog", async (c) => {
		const project = getProject(db, c.req.param("id"));
		if (!project) throw new HttpError(404, "Project not found");
		const body = (await c.req.json()) as Record<string, unknown>;
		let plan = typeof body.plan === "string" ? body.plan : "";
		if (plan.trim() === "" && typeof body.cardId === "string") {
			const card = getCard(db, body.cardId);
			if (!card || card.projectId !== project.id) throw new HttpError(404, "Card not found on this project");
			const planFile = join(paths.cardDir(config, card.id), "plan.md");
			if (!existsSync(planFile)) throw new HttpError(400, "That card has no plan.md yet — pick a planned card or paste the plan");
			plan = readFileSync(planFile, "utf8");
		}
		if (plan.trim() === "") throw new HttpError(400, 'Send the plan text, or a "cardId" whose plan.md should be cut');
		try {
			return c.json({ cards: await splitPlan({ config, driver, projectName: project.name, plan }) });
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	// Files the picked draft as inert backlog cards, in the plan's order.
	app.post("/api/projects/:id/plan-to-backlog/file", async (c) => {
		const project = getProject(db, c.req.param("id"));
		if (!project) throw new HttpError(404, "Project not found");
		const body = (await c.req.json()) as { cards?: unknown };
		const list = Array.isArray(body.cards) ? body.cards : [];
		const cleaned = list.flatMap((entry) => {
			const card = entry as Partial<{ title: unknown; brief: unknown }>;
			const title = typeof card.title === "string" && card.title.trim() ? card.title.trim().slice(0, 120) : null;
			const brief = typeof card.brief === "string" ? card.brief.slice(0, 4000) : "";
			return title ? [{ title, brief }] : [];
		});
		if (cleaned.length === 0) throw new HttpError(400, 'Send the picked cards as [{"title", "brief"}]');
		if (cleaned.length > PLAN_CARDS_MAX) throw new HttpError(400, `At most ${PLAN_CARDS_MAX} cards can be filed at once`);
		return c.json({ cards: cleaned.map((card) => createCard(project.id, card.title, card.brief)) }, 201);
	});

	app.patch("/api/projects/:id", async (c) => {
		const id = c.req.param("id");
		if (!getProject(db, id)) throw new HttpError(404, `Project not found: ${id}`);
		const body = (await c.req.json()) as Record<string, unknown>;
		const settings: ProjectSettings = {};
		if (typeof body.name === "string" && body.name.trim()) settings.name = body.name.trim();
		// An empty string clears a command.
		for (const key of ["setupCommand", "verifyCommand", "testCommand", "previewCommand", "previewUrl", "previewCheck"] as const) {
			if (typeof body[key] === "string") settings[key] = (body[key] as string).trim() || null;
		}
		if (body.reviewFlows !== undefined) {
			// null goes back to Tower's default set; [] turns reviews off.
			if (body.reviewFlows !== null && !(Array.isArray(body.reviewFlows) && body.reviewFlows.every((name) => typeof name === "string"))) throw new HttpError(400, '"reviewFlows" must be a list of flow names, or null for the default');
			const known = new Set(loadFlows(config).map((flow) => flow.name));
			const unknown = ((body.reviewFlows as string[] | null) ?? []).filter((name) => !known.has(name));
			if (unknown.length > 0) throw new HttpError(400, `There is no flow called ${unknown.map((name) => `"${name}"`).join(", ")}. Known flows: ${[...known].join(", ")}`);
			settings.reviewFlows = body.reviewFlows as string[] | null;
		}
		if (body.invariantSimulation !== undefined) {
			// null goes back to Tower's default.
			if (body.invariantSimulation !== null && typeof body.invariantSimulation !== "boolean") throw new HttpError(400, '"invariantSimulation" must be a boolean, or null for the default');
			settings.invariantSimulation = body.invariantSimulation as boolean | null;
		}
		if (body.subagents !== undefined) {
			// null goes back to Tower's default.
			if (body.subagents !== null && typeof body.subagents !== "boolean") throw new HttpError(400, '"subagents" must be a boolean, or null for the default');
			settings.subagents = body.subagents as boolean | null;
		}
		if (body.understandBeforePlan !== undefined) {
			// null goes back to Tower's default.
			if (body.understandBeforePlan !== null && typeof body.understandBeforePlan !== "boolean") throw new HttpError(400, '"understandBeforePlan" must be a boolean, or null for the default');
			settings.understandBeforePlan = body.understandBeforePlan as boolean | null;
		}
		if (body.acceptanceGates !== undefined) {
			// null goes back to Tower's default.
			if (body.acceptanceGates !== null && typeof body.acceptanceGates !== "boolean") throw new HttpError(400, '"acceptanceGates" must be a boolean, or null for the default');
			settings.acceptanceGates = body.acceptanceGates as boolean | null;
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

	// One factory, so cards made by the form and cards made by the ask look exactly the same.
	const createCard = (projectId: string, title: string, brief: string, stageConfig: Card["stageConfig"] = {}): Card => {
		const now = Date.now();
		const card: Card = {
			id: shortId(),
			projectId,
			title,
			brief,
			stage: "backlog",
			status: "idle",
			priority: 0,
			position: now,
			branchName: null,
			worktreePath: null,
			baseCommit: null,
			attempt: 0,
			stageConfig,
			prUrl: null,
			prState: null,
			needsAttentionReason: null,
			finishNote: null,
			issueUrl: null,
			issueNumber: null,
			issueAuthor: null,
			createdAt: now,
			updatedAt: now,
		};
		insertCard(db, card);
		bus.publish({ topic: "board", type: "card_upserted", data: card });
		return card;
	};

	app.post("/api/cards", async (c) => {
		const body = (await c.req.json()) as Record<string, unknown>;
		const projectId = requireString(body, "projectId");
		if (!getProject(db, projectId)) throw new HttpError(404, `Project not found: ${projectId}`);
		const card = createCard(projectId, requireString(body, "title"), typeof body.brief === "string" ? body.brief : "", typeof body.stageConfig === "object" && body.stageConfig !== null ? (body.stageConfig as Card["stageConfig"]) : {});
		return c.json(card, 201);
	});

	// One factory for both doors into greenfield work: the Projects page's form and the ask box's
	// "create a todo app". The archetype is the engineering baseline — layout, toolchain, test harness,
	// commands — so the first card plans the app itself, and the idea goes straight to planning.
	const scaffoldProject = async (name: string, archetype: string): Promise<Project> => {
		if (!listArchetypes(config).some((candidate) => candidate.name === archetype)) throw new HttpError(400, `There is no archetype called "${archetype}"`);
		const dir = targetDir(config, name);
		const manifest = await scaffoldFromArchetype({ config, archetype, dir });
		const project: Project = {
			id: shortId(),
			name,
			repoPath: dir,
			defaultBranch: "main",
			setupCommand: manifest.setup ?? null,
			verifyCommand: manifest.verify ?? null,
			testCommand: manifest.test ?? null,
			previewCommand: manifest.previewCommand ?? null,
			previewUrl: manifest.previewUrl ?? null,
			previewCheck: manifest.previewCheck ?? null,
			trustProjectPi: false,
			extensions: [],
			concurrencyLimit: 1,
			stageConfig: {},
			reviewFlows: null,
			invariantSimulation: null,
			subagents: null,
			// Nothing exists yet, so there is no system to understand first; a manifest that carries the
			// acceptance contract is born test-first.
			understandBeforePlan: false,
			acceptanceGates: manifest.acceptance === true ? true : null,
			hasOrigin: false,
			createdAt: Date.now(),
		};
		insertProject(db, project);
		bus.publish({ topic: "board", type: "project_upserted", data: project });
		return project;
	};

	// A project born from an idea.
	app.post("/api/projects/from-idea", async (c) => {
		const body = (await c.req.json()) as Record<string, unknown>;
		const name = requireString(body, "name");
		const idea = requireString(body, "idea");
		const archetype = typeof body.archetype === "string" && body.archetype.trim() ? body.archetype.trim() : "web-app";
		const project = await scaffoldProject(name, archetype);
		const card = createCard(project.id, typeof body.title === "string" && body.title.trim() ? body.title.trim() : `Build ${name}`, idea);
		await orchestrator.enqueueCard(card.id);
		return c.json({ project, card: getCard(db, card.id) ?? card }, 201);
	});

	// The command box's free-form ask: one cheap session reads the line (an @name tags the project) and
	// Tower does the acting, so the most a stray sentence can ever do is file or start one card — or,
	// when the line describes an application to build from scratch, scaffold the project for it.
	app.post("/api/assist", async (c) => {
		const text = requireString((await c.req.json()) as Record<string, unknown>, "text");
		const projects = listProjects(db).map(({ id, name }) => ({ id, name }));
		const tag = taggedProject(text, projects);

		let verdict = null;
		let readError: string | null = null;
		try {
			verdict = await readIntent({ config, driver, text, projects });
		} catch (error) {
			readError = error instanceof Error ? error.message : String(error);
		}

		if (verdict && verdict.action === "none") {
			return c.json({ ok: false, reply: `Tower left that alone — it did not read as work to file or start. Name the work, e.g. “add retry with backoff @${projects[0]?.name}”.` });
		}

		if (verdict?.action === "new_project") {
			const name = verdict.title.replace(/^build\s+/i, "").trim().slice(0, 60) || "New project";
			const archetypes = listArchetypes(config);
			const archetype = archetypes.some((candidate) => candidate.name === "web-app") ? "web-app" : archetypes[0]?.name;
			if (!archetype) throw new HttpError(400, "No archetypes are installed, so there is nothing to scaffold from");
			const project = await scaffoldProject(name, archetype);
			const card = createCard(project.id, verdict.title || `Build ${name}`, verdict.brief);
			await orchestrator.enqueueCard(card.id);
			const final = getCard(db, card.id) ?? card;
			return c.json({
				ok: true,
				action: "new_project",
				card: { id: final.id, title: final.title, stage: final.stage, status: final.status },
				projectId: project.id,
				reply: `Scaffolding “${name}” from the ${archetype} archetype — planning the idea now.`,
			});
		}

		if (projects.length === 0) throw new HttpError(400, "Add a project to the board before asking Tower to act");
		const project = (verdict && matchProject(verdict.project, projects)) ?? tag ?? (projects.length === 1 ? projects[0] : null);
		if (!project) {
			// Nowhere certain to put it: ask, rather than guess across many projects.
			return c.json({ ok: false, reply: `Which project? Tag it with @ — e.g. @${projects[0]?.name}.` });
		}

		const title = (verdict?.title || text.replaceAll(/@[\w.-]+/g, "").trim().slice(0, 120)) || text.trim().slice(0, 120);
		const brief = verdict?.brief ?? "";
		const card = createCard(project.id, title, brief);
		let action = "add_card";
		if (verdict?.action === "start_card") {
			action = "start_card";
			await orchestrator.enqueueCard(card.id);
		} else if (verdict?.action === "research_card") {
			// Explore before committing: the card is filed and the deep-research flow runs on it, no lifecycle started.
			action = "research_card";
			try {
				await orchestrator.adhoc(card.id, { flow: "deep-research" });
			} catch (error) {
				console.error(`assist: could not start the research run (${error instanceof Error ? error.message : String(error)})`);
			}
		} else if (!verdict) {
			// The intent session failed (offline, timeout): file the line as-is rather than drop it.
			console.error(`assist: falling back to a plain card (${readError})`);
		}
		const final = getCard(db, card.id) ?? card;
		return c.json({
			ok: true,
			action,
			card: { id: final.id, title: final.title, stage: final.stage, status: final.status },
			projectId: project.id,
			reply:
				action === "start_card"
					? `Started “${title}” on ${project.name}.`
					: action === "research_card"
						? `Researching “${title}” on ${project.name} — the brief will land on the card.`
						: verdict
							? `Added “${title}” to ${project.name}'s backlog.`
							: `Tower could not reach its planner, so this was filed as-is on ${project.name}.`,
		});
	});

	app.get("/api/cards/:id", (c) => {
		const card = cardOr404(c.req.param("id"));
		return c.json({ card, runs: listRunsForCard(db, card.id), gates: listGatesForCard(db, card.id), artifacts: listArtifacts(config, card.id), annotations: loadAnnotations(paths.cardDir(config, card.id)), bench: { preview: bench.previewFor(card.id) } });
	});

	// Margin notes: a person pins text on the plan, a review, a report — the notes ride back to the
	// agents with gate rejections and into the stage prompts while they are unresolved.
	const annotationDir = (cardId: string, artifact: string): string => {
		const card = cardOr404(cardId);
		if (!listArtifacts(config, card.id).some((candidate) => candidate.name === artifact)) throw new HttpError(400, `This card has no artifact "${artifact}" to annotate`);
		return paths.cardDir(config, card.id);
	};

	app.post("/api/cards/:id/annotations", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const body = (await c.req.json()) as Record<string, unknown>;
		const artifact = requireString(body, "artifact");
		const cardDir = annotationDir(card.id, artifact);
		const annotation = addAnnotation(cardDir, { artifact, quote: requireString(body, "quote"), note: requireString(body, "note") });
		return c.json({ annotation, annotations: loadAnnotations(cardDir) }, 201);
	});

	app.patch("/api/cards/:id/annotations/:annotationId", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const body = (await c.req.json()) as Record<string, unknown>;
		if (typeof body.resolved !== "boolean") throw new HttpError(400, '"resolved" must be a boolean');
		const annotations = setAnnotationResolved(paths.cardDir(config, card.id), c.req.param("annotationId"), body.resolved);
		return c.json({ annotations });
	});

	app.delete("/api/cards/:id/annotations/:annotationId", (c) => {
		const card = cardOr404(c.req.param("id"));
		const annotations = deleteAnnotation(paths.cardDir(config, card.id), c.req.param("annotationId"));
		return c.json({ annotations });
	});

	// Hands-on access to the card's worktree. Neither run can pass or fail the card.
	app.post("/api/cards/:id/test", (c) => c.json({ run: bench.test(cardOr404(c.req.param("id")).id) }, 202));
	app.post("/api/cards/:id/preview", (c) => c.json(bench.startPreview(cardOr404(c.req.param("id")).id), 202));
	app.delete("/api/cards/:id/preview", (c) => c.json(bench.stopPreview(cardOr404(c.req.param("id")).id)));

	app.post("/api/cards/:id/enqueue", async (c) => c.json(await orchestrator.enqueueCard(cardOr404(c.req.param("id")).id), 202));

	// Anyone running this Tower can say what is wrong or missing; it lands on the feedback repo as an
	// issue, and intake turns it into a backlog card only a person's approval can start.
	app.post("/api/feedback", async (c) => {
		const body = (await c.req.json()) as Record<string, unknown>;
		const kind = body.kind as FeedbackKind;
		if (kind !== "bug" && kind !== "feature" && kind !== "feedback") throw new HttpError(400, '"kind" must be "bug", "feature" or "feedback"');
		const title = requireString(body, "title");
		const details = typeof body.details === "string" ? body.details : "";
		const includeDiagnostics = body.includeDiagnostics !== false;
		try {
			return c.json(await fileFeedback({ repo: config.feedbackRepo, kind, title, details, includeDiagnostics }), 201);
		} catch (error) {
			// gh could not reach GitHub (no auth, offline): hand back the prefilled issue form instead.
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message, fallback: feedbackFallbackUrl(config.feedbackRepo, kind, title, details, includeDiagnostics) }, 503);
		}
	});

	app.post("/api/cards/:id/retry", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const feedback = typeof body.feedback === "string" && body.feedback.trim() ? body.feedback.trim() : undefined;
		return c.json(orchestrator.retry(card.id, feedback), 202);
	});

	app.get("/api/flows", (c) => {
		const flows = loadFlows(config);
		// What actually runs after tests: the person's explicit list, or the flows that ask for the trigger.
		const defaults = config.defaultReviewFlows ?? flowsTriggered(flows, "after-tests").map((flow) => flow.name);
		return c.json({ flows, defaults });
	});

	app.get("/api/usage", (c) => c.json({ byDay: usageBy(db, "day"), byProject: usageBy(db, "project"), byModel: usageBy(db, "model"), byCard: usageBy(db, "card") }));

	// Run a flow, a pi skill, one of the person's agent roles, or a plain prompt against a resting card.
	app.post("/api/cards/:id/adhoc", async (c) => {
		const card = cardOr404(c.req.param("id"));
		const body = (await c.req.json()) as Record<string, unknown>;
		const text = (key: string) => (typeof body[key] === "string" && (body[key] as string).trim() ? (body[key] as string).trim() : undefined);
		const what = [text("flow"), text("skill"), text("agent"), text("prompt")].filter(Boolean);
		if (what.length !== 1) throw new HttpError(400, 'Send exactly one of "flow", "skill", "agent" or "prompt"');
		// A card with no worktree (research on a backlog card) may only run flows that touch no code.
		if (!card.worktreePath) {
			const flowName = text("flow");
			const flow = flowName !== undefined ? loadFlows(config).find((candidate) => candidate.name === flowName) : undefined;
			if (!(flow && runsOnBacklogCard(flow))) throw new HttpError(409, "This card has no worktree yet. Start it first — only read-only flows run on a backlog card.");
		}
		const access = text("access");
		if (access && !["read-only", "read-and-run", "write"].includes(access)) throw new HttpError(400, '"access" must be read-only, read-and-run or write');
		try {
			await orchestrator.adhoc(card.id, {
				flow: text("flow"),
				skill: text("skill"),
				agent: text("agent"),
				prompt: text("prompt"),
				task: text("task"),
				model: text("model"),
				thinking: text("thinking") as never,
				access: access as never,
			});
		} catch (error) {
			if (error instanceof ConflictError) throw error;
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		return c.json({ run: listRunsForCard(db, card.id).at(-1) }, 202);
	});

	app.post("/api/cards/:id/check-pr", async (c) => {
		cardOr404(c.req.param("id"));
		await orchestrator.pollPullRequests();
		return c.json(cardOr404(c.req.param("id")));
	});

	app.post("/api/runs/:id/ui/:requestId", async (c) => {
		const body = (await c.req.json()) as Record<string, unknown>;
		const answer = body.cancelled === true ? { cancelled: true as const } : typeof body.confirmed === "boolean" ? { confirmed: body.confirmed } : typeof body.value === "string" ? { value: body.value } : null;
		if (!answer) throw new HttpError(400, 'Send "value", "confirmed" or "cancelled"');
		if (!runs.answerUi(c.req.param("id"), c.req.param("requestId"), answer)) throw new HttpError(409, "That question is no longer waiting for an answer");
		return c.json({ ok: true });
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
		// A rejection can be notes alone: the margin notes ride along as the what-should-change.
		const hasOpenNotes = loadAnnotations(paths.cardDir(config, card.id)).some((annotation) => !annotation.resolved);
		if (body.decision === "reject" && !feedback && !hasOpenNotes) throw new HttpError(400, "Say what should change so the planner can act on it");
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

	app.get("/api/cards/:id/artifacts/:name{.+}", (c) => {
		const card = cardOr404(c.req.param("id"));
		const name = decodeURIComponent(c.req.param("name"));
		const file = join(paths.cardDir(config, card.id), name);
		// Only a bare file name, or one inside reviews/: anything else (.., sessions/, absolute paths) is refused.
		const parts = name.split("/");
		const allowed = parts.every((part) => part !== "" && part !== ".." && basename(part) === part) && (parts.length === 1 || (parts.length === 2 && (parts[0] === "reviews" || parts[0] === "research")));
		if (!allowed || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, `Artifact not found: ${name}`);
		return c.text(readFileSync(file, "utf8"));
	});

	app.get("/api/runs/:id/transcript", (c) => c.json(runs.transcript(c.req.param("id"), Number(c.req.query("since") ?? 0))));

	app.get("/api/stream", (c) => handleStream(c, bus, runs));

	app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
	app.get("*", (c) => serveWeb(c, config.webDist));

	return app;
}

function listArtifacts(config: Config, cardId: string): Array<{ name: string; bytes: number; modifiedAt: number }> {
	const root = paths.cardDir(config, cardId);
	const list = (dir: string, prefix: string) =>
		existsSync(dir)
			? readdirSync(dir, { withFileTypes: true })
					.filter((entry) => entry.isFile())
					.map((entry) => {
						const stat = statSync(join(dir, entry.name));
						return { name: `${prefix}${entry.name}`, bytes: stat.size, modifiedAt: stat.mtimeMs };
					})
			: [];
	// pr-body.md is scaffolding for gh, not something to read; crew/ holds mechanical per-builder verdicts.
	return [...list(root, ""), ...list(join(root, "reviews"), "reviews/"), ...list(join(root, "research"), "research/")].filter((file) => file.name !== "pr-body.md");
}
