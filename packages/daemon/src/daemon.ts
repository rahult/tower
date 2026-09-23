import { type ServerType, serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { BenchRunner } from "./bench.ts";
import { CrewRunner } from "./crew-runner.ts";
import { openDb, type Db } from "./db/open.ts";
import { listProjects, setProjectOrigin } from "./db/repo-projects.ts";
import { Bus } from "./events/bus.ts";
import { createApp } from "./http/server.ts";
import type { SessionDriver } from "./pi/session-driver.ts";
import { FlowRunner } from "./flow-runner.ts";
import { Orchestrator } from "./orchestrator.ts";
import { listRemotes } from "./pr/gh.ts";
import { RunManager } from "./run/run-manager.ts";
import { StageRunner } from "./stage-runner.ts";

export interface Daemon {
	url: string;
	/** Resolves when nothing is running or about to run. */
	whenIdle(): Promise<void>;
	/** Checks open pull requests now, instead of waiting for the next poll. */
	pollPullRequests(): Promise<void>;
	/** Takes the feedback repo's open issues in as backlog cards now, instead of waiting for the next poll. */
	pollIssues(): Promise<void>;
	close(): Promise<void>;
}

/** Re-reads which repositories have an `origin` remote, so the board shows each project's real finish line. */
async function refreshProjectOrigins(db: Db): Promise<void> {
	for (const project of listProjects(db)) {
		try {
			const hasOrigin = (await listRemotes(project.repoPath)).includes("origin");
			if (project.hasOrigin !== hasOrigin) setProjectOrigin(db, project.id, hasOrigin);
		} catch {
			// An unreadable repository keeps its last known flag; the finish step probes again anyway.
		}
	}
}

/** Wires the daemon together. The driver is injected so tests run the whole thing against FakeSessionDriver. */
export async function startDaemon(config: Config, driver: SessionDriver): Promise<Daemon> {
	const db = openDb(paths.db(config));
	// With origin a card finishes as a pull request; without one Tower merges locally. Repositories gain and lose
	// remotes, so every boot re-probes instead of trusting the flag from when the project was added.
	await refreshProjectOrigins(db);
	const bus = new Bus();
	const runs = new RunManager(db, bus, driver, config.uiRequestTimeoutMs);
	// The runners report to the orchestrator, which in turn starts runs: bind late to close the loop.
	// The crew sits between the stage runner and its sessions: it fans a building attempt out through
	// the same startCustom door the review flows use.
	let orchestrator: Orchestrator;
	let stages: StageRunner;
	const crew = new CrewRunner({ config, db, stages: () => stages });
	stages = new StageRunner({
		config,
		db,
		bus,
		runs,
		crew,
		onStarted: (cardId) => orchestrator.handleStarted(cardId),
		onOutcome: (cardId, outcome) => orchestrator.handleOutcome(cardId, outcome),
	});
	const flows = new FlowRunner({ config, db, bus, runs, stages });
	orchestrator = new Orchestrator({ config, db, bus, runs, stages, flows });
	const bench = new BenchRunner({ config, db, bus, runs });
	const app = createApp({ config, db, bus, runs, stages, orchestrator, bench, driver });
	// Whatever the previous process left in flight is interrupted; queued work carries on.
	orchestrator.recover();
	orchestrator.watchPullRequests();
	orchestrator.watchIssues();

	const server: ServerType = await new Promise((resolve) => {
		const started = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(started));
	});
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://${config.host}:${port}`,
		whenIdle: () => orchestrator.whenIdle(),
		pollPullRequests: () => orchestrator.pollPullRequests(),
		pollIssues: () => orchestrator.pollIssues(),
		async close() {
			orchestrator.beginShutdown();
			bench.beginShutdown();
			await runs.stopAll();
			await orchestrator.whenIdle();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				// SSE connections are long-lived; do not let them hold shutdown open.
				(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
			});
			db.close();
		},
	};
}
