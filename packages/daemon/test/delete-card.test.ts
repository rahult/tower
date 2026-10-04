import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness, planningTurn } from "./harness.ts";

let h: Harness;
afterEach(async () => {
	await h?.close();
});

const registeredWorktrees = (repo: string): string =>
	execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });

describe("deleting a card", () => {
	it("deletes a card resting mid-stage at a gate, and takes its worktree with it", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Stuck", brief: "" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		expect(existsSync(detail.card.worktreePath)).toBe(true);
		expect(registeredWorktrees(h.repo)).toContain(detail.card.worktreePath);

		expect((await h.api("DELETE", `/api/cards/${card.id}`)).status).toBe(200);
		expect((await h.api("GET", `/api/cards/${card.id}`)).status).toBe(404);
		// The repository stops advertising a worktree for a card that no longer exists.
		expect(existsSync(detail.card.worktreePath)).toBe(false);
		expect(registeredWorktrees(h.repo)).not.toContain(detail.card.worktreePath);
	});

	it("deletes a card that stopped for attention, with no work in flight", async () => {
		// A planner that writes no verdict: the card stops and asks for a person.
		h = await bootHarness((spec) => (spec.sessionId.includes("-plan-") ? [planningTurn({ writeResult: false })] : byStage()(spec)));
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Stopped", brief: "" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card.status).toBe("needs_attention");

		expect((await h.api("DELETE", `/api/cards/${card.id}`)).status).toBe(200);
		expect((await h.api("GET", "/api/board")).body.cards.find((candidate: { id: string }) => candidate.id === card.id)).toBeUndefined();
	});

	it("still refuses while the card is busy", async () => {
		h = await bootHarness((spec) => (spec.sessionId.includes("-plan-") ? [planningTurn({ delayMs: 250 })] : byStage()(spec)));
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Busy", brief: "" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		expect((await h.api("DELETE", `/api/cards/${card.id}`)).status).toBe(409);
		await h.api("POST", `/api/cards/${card.id}/abort`);
		await h.daemon.whenIdle();
	});
});
