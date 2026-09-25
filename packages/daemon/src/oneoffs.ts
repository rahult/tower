import { randomUUID } from "node:crypto";
import type { Db } from "./db/open.ts";
import { insertOneoffRun } from "./db/repo-oneoffs.ts";
import type { RunHandle } from "./pi/session-driver.ts";

export type OneoffKind = "assist" | "suggest" | "model-check";

/** What a one-off session spent, pulled off its handle after the turn settled. */
export function recordOneoff(db: Db, kind: OneoffKind, model: string, handle: RunHandle): void {
	void (async () => {
		try {
			const stats = await handle.stats();
			insertOneoffRun(db, {
				id: `oneoff-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
				kind,
				model,
				tokensJson: stats?.tokens ? JSON.stringify(stats.tokens) : null,
				costUsd: stats?.costUsd ?? null,
				startedAt: Date.now(),
			});
		} catch (error) {
			console.error(`oneoff ${kind} usage could not be recorded:`, error);
		}
	})();
}
