import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

describe("similar-card warnings at filing time", () => {
	it("returns the open cards that share the typed work's words, closest first", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const retry = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Retry failed requests with backoff", brief: "The HTTP client gives up after one failure." })).body;
		await h.api("POST", "/api/cards", { projectId: project.id, title: "Dark mode for the settings page", brief: "" });
		const res = await h.api("GET", `/api/projects/${project.id}/similar-cards?q=${encodeURIComponent("Add retry with backoff to the HTTP client")}`);
		expect(res.status).toBe(200);
		expect(res.body.cards.map((card: { id: string }) => card.id)).toEqual([retry.id]);
	});

	it("stays quiet for unrelated text, landed cards, and an empty query", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const landed = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Retry failed requests with backoff", brief: "" })).body;
		await h.api("POST", `/api/cards/${landed.id}/enqueue`);
		await h.daemon.whenIdle();
		const planGate = (await h.api("GET", `/api/cards/${landed.id}`)).body.gates[0];
		await h.api("POST", `/api/cards/${landed.id}/gates/${planGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const reviewGate = (await h.api("GET", `/api/cards/${landed.id}`)).body.gates.find((gate: { status: string }) => gate.status === "pending");
		await h.api("POST", `/api/cards/${landed.id}/gates/${reviewGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${landed.id}`)).body.card.stage).toBe("done");

		const landedOnly = await h.api("GET", `/api/projects/${project.id}/similar-cards?q=${encodeURIComponent("Retry failed requests with backoff")}`);
		expect(landedOnly.body.cards).toEqual([]);

		const blank = await h.api("GET", `/api/projects/${project.id}/similar-cards?q=`);
		expect(blank.body.cards).toEqual([]);
	});

	it("answers 404 for a project that does not exist", async () => {
		h = await bootHarness(byStage());
		const res = await h.api("GET", "/api/projects/nope/similar-cards?q=anything");
		expect(res.status).toBe(404);
	});
});
