/**
 * Model pricing for cache-savings math. Money only ever enters Tower as pi's own per-run
 * `costUsd` (already cache-aware) — this table exists solely to answer "how much did the
 * provider's prompt cache save?", which pi's scalar total cannot say on its own.
 *
 * Rates are per 1M tokens, conservative list prices (peak where a provider has peak/off-peak).
 * Matching is by substring on the run's model string (e.g. "openrouter/deepseek/deepseek-chat").
 * Unknown models return null — the UI shows nothing rather than a wrong figure.
 */

export interface ModelRates {
	input: number;
	/** Reading a cached prefix. */
	cacheRead: number;
	/** Writing a new cache entry (some providers charge a premium, e.g. Anthropic 1h TTL). */
	cacheWrite: number;
	output: number;
}

const RATES: Array<{ match: string; rates: ModelRates }> = [
	{ match: "deepseek", rates: { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2 } },
	{ match: "claude-opus", rates: { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 } },
	{ match: "claude-sonnet", rates: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 } },
	{ match: "claude-haiku", rates: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } },
	{ match: "gpt-5", rates: { input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10 } },
	{ match: "glm-5.3", rates: { input: 0.6, cacheRead: 0.06, cacheWrite: 0.6, output: 2.2 } },
];

export function ratesFor(model: string): ModelRates | null {
	const lower = model.toLowerCase();
	for (const entry of RATES) if (lower.includes(entry.match)) return entry.rates;
	return null;
}

export interface TokenUsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Dollars saved because cached tokens billed at the cache rate instead of the input rate.
 * Null when the model's pricing is unknown or nothing was cached.
 */
export function cacheSavingsUsd(model: string, tokens: TokenUsageLike | null): number | null {
	if (!tokens || (tokens.cacheRead === 0 && tokens.cacheWrite === 0)) return null;
	const rates = ratesFor(model);
	if (!rates) return null;
	const savedRead = (tokens.cacheRead * (rates.input - rates.cacheRead)) / 1e6;
	const savedWrite = (tokens.cacheWrite * (rates.input - rates.cacheWrite)) / 1e6;
	return savedRead + savedWrite;
}
