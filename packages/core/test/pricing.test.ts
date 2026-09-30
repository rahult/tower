import { describe, expect, it } from "vitest";
import { cacheSavingsUsd, ratesFor } from "../src/pricing.ts";

describe("ratesFor", () => {
	it("matches models by substring, case-insensitively", () => {
		expect(ratesFor("openrouter/deepseek/deepseek-chat")?.input).toBe(0.3);
		expect(ratesFor("Anthropic/Claude-Sonnet-4.5")?.cacheRead).toBe(0.3);
		expect(ratesFor("ollama/qwen2.5-coder:7b")).toBeNull();
	});
});

describe("cacheSavingsUsd", () => {
	it("prices cached reads at the gap between input and cache-read rates", () => {
		// deepseek: 1M cached read tokens would have cost $0.30 at input rates, billed $0.006.
		const saved = cacheSavingsUsd("openrouter/deepseek/deepseek-chat", { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 });
		expect(saved).toBeCloseTo(0.294, 3);
	});
	it("returns null when nothing was cached or the model is unknown", () => {
		expect(cacheSavingsUsd("openrouter/deepseek/deepseek-chat", { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
		expect(cacheSavingsUsd("ollama/qwen2.5-coder:7b", { input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 })).toBeNull();
		expect(cacheSavingsUsd("any", null)).toBeNull();
	});
	it("counts premium cache writes (anthropic 1h) as negative savings", () => {
		// claude-sonnet cacheWrite $3.75 > input $3.00: writing cache costs MORE than plain input.
		const saved = cacheSavingsUsd("claude-sonnet", { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 });
		expect(saved).toBeCloseTo(-0.75, 3);
	});
});
