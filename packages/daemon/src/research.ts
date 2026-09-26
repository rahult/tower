import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrompt, resolveStageConfig, type RunSpec, type ThinkingLevel } from "@tower/core";
import { paths } from "./config.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/open.ts";
import { getQuestion, insertQuestion, listQuestions, resetQuestionRun, setQuestionBrief, setQuestionStatus, setQuestionStep } from "./db/repo-research.ts";
import { toolsFor } from "./flows.ts";
import { recordOneoff } from "./oneoffs.ts";
import type { SessionDriver } from "./pi/session-driver.ts";

/** Where a step's prompt template lives: shipped with Tower, or beside a person's own files. */
const readPrompt = (config: Config, ...parts: string[]): string => {
	const shipped = join(config.promptsDir, ...parts);
	if (existsSync(shipped)) return readFileSync(shipped, "utf8");
	return readFileSync(join(config.home, ...parts), "utf8");
};

/**
 * The Research lane: a question asked before any project exists. Two sessions run where the question
 * stands — a survey that gathers evidence over the network (and probes with spike code when reading
 * cannot settle it), then a synthesizer that writes the cited brief. Promotion, a person's decision,
 * files the brief as a card whose planner reads it. The runs are card-less: their spend lands in the
 * one-off ledger, their transcripts under <home>/research.
 */
export class ResearchRunner {
	private readonly deps: { config: Config; db: Db; driver: SessionDriver };
	/** The question runs in flight, so shutdown can stop them and tests can wait for them. */
	private readonly inFlight = new Map<string, Promise<void>>();
	/** Each question's live sessions, so a cancel or a shutdown stops exactly the right ones. */
	private readonly questionHandles = new Map<string, Set<{ stop: () => Promise<unknown> }>>();
	/** Questions whose run was cancelled: the run's remaining steps must not start. */
	private readonly cancelled = new Set<string>();
	private stopping = false;

	constructor(deps: { config: Config; db: Db; driver: SessionDriver }) {
		this.deps = deps;
		// Whatever a previous process was researching is not running any more; the question stays askable.
		this.deps.db.prepare("UPDATE research_questions SET status = 'open', step = NULL WHERE status = 'running'").run();
	}

	list() {
		return listQuestions(this.deps.db);
	}

	get(id: string) {
		return getQuestion(this.deps.db, id);
	}

	/** Files a question and starts its research. The row returns immediately, marked running. */
	ask(question: string) {
		const row = insertQuestion(this.deps.db, randomUUID().replaceAll("-", "").slice(0, 8), question, Date.now());
		this.start(row.id);
		return row;
	}

	/** (Re)runs a question — the way a failed survey is tried again, and the only door from open. */
	run(id: string): void {
		const question = getQuestion(this.deps.db, id);
		if (!question || (question.status !== "open" && question.status !== "running")) return;
		setQuestionStatus(this.deps.db, id, "running");
		this.start(id);
	}

	/** Stops a running question mid-flight and returns it to open, so it can be asked again. */
	cancel(id: string): boolean {
		if (!this.inFlight.has(id)) return false;
		this.cancelled.add(id);
		resetQuestionRun(this.deps.db, id);
		for (const handle of this.questionHandles.get(id) ?? []) void handle.stop().catch(() => {});
		return true;
	}

	private start(id: string): void {
		// A fresh run is a new verdict: it forgets any cancel aimed at the run before it.
		this.cancelled.delete(id);
		const work = this.research(id)
			.catch((error) => {
				// A cancelled (or shutting-down) run fails quietly — that is the point of cancel.
				if (this.stopping || this.cancelled.has(id)) return;
				// A failed run returns the question to open, so it can be asked again; the error is logged, not lost.
				console.error(`research ${id} failed:`, error);
				setQuestionStatus(this.deps.db, id, "open");
				setQuestionStep(this.deps.db, id, null);
			})
			.finally(() => {
				// A re-run may already own the slot; the superseded work must not clean up after it.
				if (this.inFlight.get(id) === work) {
					this.inFlight.delete(id);
					this.cancelled.delete(id);
				}
			});
		this.inFlight.set(id, work);
	}

	whenIdle(): Promise<void> {
		if (this.inFlight.size === 0) return Promise.resolve();
		const current = [...this.inFlight.values()];
		return Promise.allSettled(current).then(() => this.whenIdle());
	}

	async beginShutdown(): Promise<void> {
		this.stopping = true;
		for (const handles of this.questionHandles.values()) for (const handle of handles) await handle.stop().catch(() => {});
	}

	/** The two steps, in order; the brief lands in the database where promotion finds it. */
	private async research(id: string): Promise<void> {
		const { config, db } = this.deps;
		const row = getQuestion(db, id);
		if (!row) return;
		const dir = paths.research(config, id);
		const model = resolveStageConfig("planning", { global: config.globalStageConfig });
		const surveyReport = join(dir, "survey.md");
		const briefReport = join(dir, "brief.md");

		setQuestionStep(db, id, "survey");
		const surveyPrompt = renderPrompt(readPrompt(config, "research", "question-survey.md"), { question: row.question, reportPath: surveyReport, pinnedSources: "" }, {});
		await this.session(id, `research-survey-${id}`, dir, model, surveyPrompt);
		if (this.stopping || this.cancelled.has(id)) return;

		setQuestionStep(db, id, "brief");
		const briefPrompt = renderPrompt(readPrompt(config, "research", "question-brief.md"), { question: row.question, surveyPath: surveyReport, reportPath: briefReport }, {});
		await this.session(id, `research-brief-${id}`, dir, model, briefPrompt);
		if (this.stopping || this.cancelled.has(id)) return;

		if (!existsSync(briefReport)) throw new Error("the synthesizer wrote no brief");
		setQuestionBrief(db, id, readFileSync(briefReport, "utf8"));
	}

	/** One card-less session with tools: the survey fetches and probes, the synthesizer writes. */
	private async session(questionId: string, sessionId: string, cwd: string, model: { model: string; thinking: ThinkingLevel }, prompt: string): Promise<void> {
		const { config, db, driver } = this.deps;
		const sessionDir = join(config.home, "research", "sessions", sessionId, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const spec: RunSpec = {
			sessionId,
			cwd,
			sessionDir,
			model: model.model,
			thinking: model.thinking,
			tools: toolsFor("read-and-run"),
			extensions: [],
			trustProject: false,
			appendSystemPromptFiles: [],
		};
		const handle = await driver.start(spec);
		recordOneoff(db, "research", model.model, handle);
		let handles = this.questionHandles.get(questionId);
		if (!handles) {
			handles = new Set();
			this.questionHandles.set(questionId, handles);
		}
		handles.add(handle);
		try {
			await handle.prompt(prompt);
			await handle.waitSettled();
		} finally {
			handles.delete(handle);
			if (handles.size === 0) this.questionHandles.delete(questionId);
			await handle.stop().catch(() => {});
		}
	}
}
