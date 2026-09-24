import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

describe("the command probe", () => {
	it("has an agent read the repository and returns drafted commands for a project", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const res = await h.api("POST", `/api/projects/${project.id}/suggest-commands`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ verify: "pnpm test", test: "pnpm test --run", setup: "pnpm install --prefer-offline", previewCommand: null, previewUrl: null });
	});

	it("answers 404 for a project that does not exist", async () => {
		h = await bootHarness(byStage());
		const res = await h.api("POST", "/api/projects/nope/suggest-commands");
		expect(res.status).toBe(404);
	});
});
