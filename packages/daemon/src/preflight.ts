import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { DriverEvent, RunHandle, SessionDriver } from "./pi/session-driver.ts";

export interface ModelCheck {
	/** The model probed, named exactly as a stage would name it. */
	model: string;
	ok: boolean;
	/** The provider's own words when the probe failed; null when it answered. */
	error: string | null;
	/** Wall-clock the probe took, so a slow model is visible before real work hangs on it. */
	ms: number;
}

const PROBE = "Reply with exactly: OK";
const TIMEOUT_MS = 90_000;

/**
 * Probe the models a board runs its stages on: one tiny session per model through the same driver
 * and invocation shape a stage uses — no tools, no extensions, one-line prompt. The verdict is what
 * the session actually did: a provider rejection (no key, exhausted quota, unknown model) arrives as
 * the assistant message's error rather than a thrown exception, so it is read off the settled turn.
 */
export async function checkModels(options: { config: Config; driver: SessionDriver; models: string[]; timeoutMs?: number }): Promise<ModelCheck[]> {
	const models = [...new Set(options.models.map((model) => model.trim()).filter(Boolean))];
	return Promise.all(models.map((model) => checkModel(options.config, options.driver, model, options.timeoutMs ?? TIMEOUT_MS)));
}

async function checkModel(config: Config, driver: SessionDriver, model: string, timeoutMs: number): Promise<ModelCheck> {
	const started = Date.now();
	const slug = model.replace(/[^a-zA-Z0-9.-]+/g, "-");
	const sessionId = `model-check-${slug}-${Date.now().toString(36)}`;
	const sessionDir = join(config.home, "checks", sessionId);
	mkdirSync(sessionDir, { recursive: true });
	let providerError: string | null = null;
	let handle: RunHandle | null = null;
	let stopWatching: (() => void) | null = null;
	const timeout = new Promise<never>((_, reject) => {
		const timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
		timer.unref();
	});
	try {
		handle = await driver.start({ sessionId, cwd: config.home, sessionDir, model, thinking: "off", tools: [], extensions: [], trustProject: false, appendSystemPromptFiles: [] });
		stopWatching = handle.onEvent((event: DriverEvent) => {
			if (event.type === "message" && event.message.role === "assistant") providerError = event.message.error ?? providerError;
		});
		const settled = handle.waitSettled();
		settled.catch(() => {});
		await handle.prompt(PROBE);
		await Promise.race([settled, timeout]);
		return providerError ? { model, ok: false, error: providerError, ms: Date.now() - started } : { model, ok: true, error: null, ms: Date.now() - started };
	} catch (error) {
		return { model, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
	} finally {
		stopWatching?.();
		await handle?.stop().catch(() => {});
	}
}
