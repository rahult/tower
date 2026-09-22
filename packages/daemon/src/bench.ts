import { spawn, type ChildProcess } from "node:child_process";
import type { Card, Project, StageRun } from "@tower/core";
import { type Config } from "./config.ts";
import type { Db } from "./db/open.ts";
import { getCard } from "./db/repo-cards.ts";
import { getProject } from "./db/repo-projects.ts";
import { getRun, insertRun, listRunsForCard, updateRun } from "./db/repo-runs.ts";
import type { Bus } from "./events/bus.ts";
import type { RunManager } from "./run/run-manager.ts";
import { runVerify } from "./verifier.ts";

export interface BenchDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
}

/** The request conflicts with what the card or project currently allows. */
export class BenchError extends Error {
	readonly status: 400 | 404 | 409;
	constructor(status: 400 | 404 | 409, message: string) {
		super(message);
		this.status = status;
	}
}

/** What the UI needs to draw the preview row: the process, where it serves, since when. */
export interface PreviewState {
	running: boolean;
	command: string | null;
	url: string | null;
	startedAt: number | null;
}

const NO_PREVIEW: PreviewState = { running: false, command: null, url: null, startedAt: null };

/**
 * Hands-on access to a card's worktree, on the person's say-so: run the project's tests on demand, and keep a
 * dev-server preview of the card's branch alive while they click through it. Neither touches the card's
 * lifecycle — the verify command stays the only thing that can pass or fail a card.
 */
export class BenchRunner {
	private readonly deps: BenchDeps;
	/** One preview per card: the process group, so stopping kills the whole tree (pnpm → vite → …). */
	private readonly previews = new Map<string, { child: ChildProcess; project: Project; startedAt: number }>();
	/** Abort handles for in-flight test runs, so shutdown can stop them without recording a verdict. */
	private readonly testAborts = new Map<string, () => void>();
	private stopping = false;

	constructor(deps: BenchDeps) {
		this.deps = deps;
	}

	private cardWithWorktree(cardId: string): { card: Card; project: Project } {
		const card = getCard(this.deps.db, cardId);
		if (!card) throw new BenchError(404, `Card not found: ${cardId}`);
		const project = getProject(this.deps.db, card.projectId);
		if (!card.worktreePath || !project) throw new BenchError(409, "This card has no worktree yet. Start it first.");
		return { card, project };
	}

	/** Runs the project's test command in the card's worktree and returns its run row. Settles on its own. */
	test(cardId: string): StageRun {
		const { config, db, runs } = this.deps;
		const { card, project } = this.cardWithWorktree(cardId);
		if (!project.testCommand) throw new BenchError(400, `No test command is set for ${project.name}. Add one in its project settings.`);
		if (runs.liveRunForCard(cardId)) throw new BenchError(409, "Something is already running for this card. Wait for it or abort it first.");

		// The lifecycle's own tester sessions already own the "-test-N" id space; bench runs take their own.
		const attempt = listRunsForCard(db, cardId).filter((run) => run.kind === "test").length + 1;
		const run: StageRun = {
			id: `c${cardId}-bench-${attempt}`,
			cardId,
			kind: "test",
			stage: card.stage,
			attempt,
			model: project.testCommand,
			thinking: "off",
			args: [],
			status: "running",
			resultStatus: null,
			resultSummary: null,
			questions: null,
			tokens: null,
			costUsd: null,
			lastEntryId: null,
			startedAt: Date.now(),
			endedAt: null,
			error: null,
		};
		// The lease is taken before the row exists: if taking it fails, nothing was recorded.
		const live = runs.openLog(cardId, run.id);
		insertRun(db, run);
		const publishRun = () => this.deps.bus.publish({ topic: "board", type: "run_upserted", data: getRun(db, run.id) });
		publishRun();

		const work = (async () => {
			try {
				const { done, abort } = runVerify({ command: project.testCommand as string, cwd: card.worktreePath as string, timeoutMs: config.verifyTimeoutMs, buffer: live.buffer });
				this.testAborts.set(cardId, abort);
				const result = await done;
				if (this.stopping) return;
				const summary = result.aborted ? "Stopped." : result.passed ? "Tests passed." : `Tests exited with code ${result.exitCode}.`;
				updateRun(db, run.id, { status: result.aborted ? "aborted" : "settled", resultStatus: result.aborted ? null : result.passed ? "pass" : "fail", resultSummary: summary, endedAt: Date.now() });
				runs.note(run.id, "run_finished", { status: summary });
			} catch (error) {
				updateRun(db, run.id, { status: "failed", error: error instanceof Error ? error.message : String(error), endedAt: Date.now() });
			} finally {
				this.testAborts.delete(cardId);
				await runs.finish(run.id);
				// Shutdown may have closed the database under us; the recovery pass owns recording from here.
				if (!this.stopping) publishRun();
			}
		})();
		// A bench run is nobody's dependency; the only failure mode is a bug, and the row already says "failed".
		work.catch((error) => console.error(`test run ${run.id} failed unexpectedly:`, error));
		return run;
	}

	/** Starts the project's preview command in the card's worktree. Replaces nothing: one preview per card. */
	startPreview(cardId: string): PreviewState {
		const { card, project } = this.cardWithWorktree(cardId);
		if (!project.previewCommand) throw new BenchError(400, `No preview command is set for ${project.name}. Add one in its project settings.`);
		if (this.previews.has(cardId)) throw new BenchError(409, "The preview for this card is already running.");

		// detached: the preview becomes a process-group leader, so stopping kills the whole tree.
		const child = spawn(project.previewCommand, { cwd: card.worktreePath as string, shell: true, detached: true, stdio: "ignore" });
		child.unref();
		const startedAt = Date.now();
		this.previews.set(cardId, { child, project, startedAt });
		child.once("close", () => {
			if (this.previews.get(cardId)?.child === child) {
				this.previews.delete(cardId);
				this.publish(cardId);
			}
		});
		this.publish(cardId);
		return this.previewFor(cardId);
	}

	stopPreview(cardId: string): PreviewState {
		const entry = this.previews.get(cardId);
		if (!entry) throw new BenchError(409, "No preview is running for this card.");
		// Delete first so the close event sees a state that is already "stopped".
		this.previews.delete(cardId);
		try {
			if (entry.child.pid) process.kill(-entry.child.pid, "SIGKILL");
		} catch {
			// already gone
		}
		this.publish(cardId);
		return this.previewFor(cardId);
	}

	previewFor(cardId: string): PreviewState {
		const entry = this.previews.get(cardId);
		if (!entry) return NO_PREVIEW;
		return { running: true, command: entry.project.previewCommand, url: entry.project.previewUrl, startedAt: entry.startedAt };
	}

	/** Kills previews and in-flight test commands without recording how they ended, for shutdown and recovery. */
	beginShutdown(): void {
		this.stopping = true;
		for (const abort of this.testAborts.values()) abort();
		for (const cardId of [...this.previews.keys()]) {
			const entry = this.previews.get(cardId);
			this.previews.delete(cardId);
			try {
				if (entry?.child.pid) process.kill(-entry.child.pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}

	private publish(cardId: string): void {
		this.deps.bus.publish({ topic: "board", type: "bench_changed", data: { cardId, preview: this.previewFor(cardId) } });
	}
}
