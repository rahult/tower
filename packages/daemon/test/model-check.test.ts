import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, type FakeTurn, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const OK_TURN: FakeTurn[] = [{ events: [{ type: "message", message: { role: "assistant", text: "OK", thinking: "", toolCalls: [] } }] }];

describe("model checks", () => {
	it("reports which configured models can answer and which cannot, in the provider's own words", async () => {
		const rejected: FakeTurn[] = [{ events: [{ type: "message", message: { role: "assistant", text: "", thinking: "", toolCalls: [], error: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going. (HTTP 400)" } }] }];
		h = await bootHarness((spec) => (spec.model.includes("dead") ? rejected : OK_TURN));
		const { status, body } = await h.api("POST", "/api/settings/check-models", { models: ["alive/model", "dead/model", "alive/model", "  "] });
		expect(status).toBe(200);
		expect(body.checks).toHaveLength(2);
		const alive = body.checks.find((check: { model: string }) => check.model === "alive/model");
		const dead = body.checks.find((check: { model: string }) => check.model === "dead/model");
		expect(alive).toMatchObject({ ok: true, error: null });
		expect(dead).toMatchObject({ ok: false });
		expect(dead.error).toContain("out of extra usage");
		expect(dead.ms).toBeGreaterThanOrEqual(0);
	});

	it("refuses to run with no models named", async () => {
		h = await bootHarness(() => OK_TURN);
		const { status, body } = await h.api("POST", "/api/settings/check-models", { models: [] });
		expect(status).toBe(400);
		expect(body.error).toContain("models");
	});

	it("probes through the real invocation shape: no tools, no prompts, its own session", async () => {
		h = await bootHarness(() => OK_TURN);
		await h.api("POST", "/api/settings/check-models", { models: ["probe/model"] });
		const handle = h.driver.handles[0];
		expect(handle?.spec.sessionId).toMatch(/^model-check-probe-model-/);
		expect(handle?.spec.tools).toEqual([]);
		expect(handle?.spec.appendSystemPromptFiles).toEqual([]);
		expect(handle?.spec.extensions).toEqual([]);
		expect(handle?.spec.thinking).toBe("off");
		expect(handle?.prompts).toEqual(["Reply with exactly: OK"]);
	});

	it("survives a model that never answers", async () => {
		h = await bootHarness((spec) => (spec.model.includes("hang") ? [{ events: [], hang: true }] : OK_TURN));
		const { body } = await h.api("POST", "/api/settings/check-models", { models: ["hang/model"], timeoutMs: 300 });
		expect(body.checks[0]).toMatchObject({ model: "hang/model", ok: false });
		expect(body.checks[0].error).toContain("no answer within");
		// The hung session was torn down, not left running.
		expect(h.driver.handles[0]?.stopped).toBe(true);
	});
});
