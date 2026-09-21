import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const MODELS = { planning: { model: "zai/glm-5.3" }, building: { model: "zai/glm-5.3-flash", thinking: "low" } };

async function planAndBuild(harness: Harness) {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: "Todo app" })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	const gate = (await harness.api("GET", `/api/cards/${card.id}`)).body.gates[0];
	await harness.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
	await harness.daemon.whenIdle();
	return harness.driver.handles.map((handle) => [handle.sessionId.split("-")[1], handle.spec.model, handle.spec.thinking]);
}

describe("model settings", () => {
	it("reports the stage defaults until something is configured", async () => {
		h = await bootHarness(byStage());
		const { body } = await h.api("GET", "/api/settings");
		expect(body.models.planning).toEqual({ model: "anthropic/claude-fable-5-1", thinking: "high", source: "default" });
		expect(body.models.building).toMatchObject({ model: "zai/glm-5.3", source: "default" });
		expect(body.file).toBe(join(h.home, "config.json"));
	});

	it("applies saved models to the next sessions, writes them to config.json, and keeps them across a restart", async () => {
		h = await bootHarness(byStage());
		const saved = await h.api("PUT", "/api/settings", { models: MODELS });
		expect(saved.status).toBe(200);
		expect(saved.body.models.planning).toEqual({ model: "zai/glm-5.3", thinking: "high", source: "config" });
		expect(saved.body.models.building).toEqual({ model: "zai/glm-5.3-flash", thinking: "low", source: "config" });
		expect(JSON.parse(readFileSync(join(h.home, "config.json"), "utf8"))).toEqual({ models: MODELS });

		await h.restart();
		expect((await h.api("GET", "/api/settings")).body.models.building.model).toBe("zai/glm-5.3-flash");
		expect(await planAndBuild(h)).toEqual([
			["plan", "zai/glm-5.3", "high"],
			["build", "zai/glm-5.3-flash", "low"],
			["test", "zai/glm-5.3", "medium"],
		]);
	});

	it("reads a config.json the user wrote by hand", async () => {
		h = await bootHarness(byStage());
		mkdirSync(h.home, { recursive: true });
		writeFileSync(join(h.home, "config.json"), JSON.stringify({ models: { planning: { model: "kimi-coding/k3", thinking: "medium" } } }));
		await h.restart();
		expect((await h.api("GET", "/api/settings")).body.models.planning).toEqual({ model: "kimi-coding/k3", thinking: "medium", source: "config" });
	});

	it("lets a card's own override win over the configured model", async () => {
		h = await bootHarness(byStage());
		await h.api("PUT", "/api/settings", { models: MODELS });
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x", stageConfig: { planning: { model: "deepseek/deepseek-v4-pro" } } })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		expect(h.driver.handles[0]?.spec.model).toBe("deepseek/deepseek-v4-pro");
	});

	it("clears a stage back to its default", async () => {
		h = await bootHarness(byStage());
		await h.api("PUT", "/api/settings", { models: MODELS });
		const cleared = await h.api("PUT", "/api/settings", { models: { planning: null, building: MODELS.building } });
		expect(cleared.body.models.planning.source).toBe("default");
		expect(cleared.body.models.building.source).toBe("config");
	});

	it.each([
		[{ models: { planning: { model: "glm-5.3" } } }, "provider/model"],
		[{ models: { planning: { model: "zai/glm-5.3", thinking: "extreme" } } }, "thinking"],
		[{ models: { deploying: { model: "zai/glm-5.3" } } }, "deploying"],
		[{ models: "zai/glm-5.3" }, "models"],
	])("rejects %j", async (body, hint) => {
		h = await bootHarness(byStage());
		const response = await h.api("PUT", "/api/settings", body);
		expect(response.status).toBe(400);
		expect(response.body.error).toContain(hint);
	});
});
