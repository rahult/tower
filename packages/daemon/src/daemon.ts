import { type ServerType, serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { openDb } from "./db/open.ts";
import { Bus } from "./events/bus.ts";
import { createApp } from "./http/server.ts";
import type { SessionDriver } from "./pi/session-driver.ts";
import { Orchestrator } from "./orchestrator.ts";
import { RunManager } from "./run/run-manager.ts";
import { StageRunner } from "./stage-runner.ts";

export interface Daemon {
	url: string;
	/** Resolves when nothing is running or about to run. */
	whenIdle(): Promise<void>;
	close(): Promise<void>;
}

/** Wires the daemon together. The driver is injected so tests run the whole thing against FakeSessionDriver. */
export async function startDaemon(config: Config, driver: SessionDriver): Promise<Daemon> {
	const db = openDb(paths.db(config));
	const bus = new Bus();
	const runs = new RunManager(db, bus, driver);
	// The runner reports to the orchestrator, which in turn starts runs: bind late to close the loop.
	let orchestrator: Orchestrator;
	const stages = new StageRunner({
		config,
		db,
		bus,
		runs,
		onStarted: (cardId) => orchestrator.handleStarted(cardId),
		onOutcome: (cardId, outcome) => orchestrator.handleOutcome(cardId, outcome),
	});
	orchestrator = new Orchestrator({ config, db, bus, stages });
	const app = createApp({ config, db, bus, runs, stages, orchestrator });

	const server: ServerType = await new Promise((resolve) => {
		const started = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(started));
	});
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://${config.host}:${port}`,
		whenIdle: () => orchestrator.whenIdle(),
		async close() {
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
