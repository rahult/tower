import { afterEach, describe, expect, it } from "vitest";
import { normalise } from "../src/pi/normalise.ts";
import { bootHarness, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

// What pi 0.85.1 emits when a provider rejects the request (recorded from a real Anthropic 400).
const REJECTED = {
	type: "message_end",
	message: {
		role: "assistant",
		content: [],
		provider: "anthropic",
		model: "claude-fable-5-1",
		stopReason: "error",
		errorMessage: '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_1"}',
	},
};

describe("provider errors", () => {
	it("normalise keeps the provider's error and makes it readable", () => {
		expect(normalise(REJECTED)).toEqual([
			{
				type: "message",
				message: { role: "assistant", text: "", thinking: "", toolCalls: [], error: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going. (HTTP 400)" },
			},
		]);
	});

	it("keeps an error that is not JSON as it is", () => {
		const [event] = normalise({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" } });
		expect(event).toMatchObject({ message: { error: "fetch failed" } });
	});

	it("fails the stage with the provider's words, without nudging a model that cannot answer", async () => {
		const rejected = normalise(REJECTED);
		h = await bootHarness(() => [{ events: rejected }, { events: rejected }]);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Todo app" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card.status).toBe("needs_attention");
		expect(detail.card.needsAttentionReason).toContain("anthropic/claude-fable-5-1");
		expect(detail.card.needsAttentionReason).toContain("out of extra usage");
		expect(detail.card.needsAttentionReason).not.toContain("stage-result.json");
		expect(detail.runs[0]).toMatchObject({ status: "failed" });
		// The session still burned tokens before failing; its spend must land in usage.
		expect(detail.runs[0]).toMatchObject({ tokens: { total: 120 }, costUsd: 0.001 });
		expect(h.driver.handles[0]?.prompts).toHaveLength(1);
	});
});
