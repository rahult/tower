import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

describe("repositories Tower cannot branch from", () => {
	it("refuses a repository with no commits, and says how to fix it", async () => {
		h = await bootHarness(byStage());
		const empty = join(h.home, "..", "fresh");
		mkdirSync(empty, { recursive: true });
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: empty });

		const response = await h.api("POST", "/api/projects", { repoPath: empty });
		expect(response.status).toBe(400);
		expect(response.body.error).toContain("has no commits yet");
		expect(response.body.error).toContain("commit --allow-empty");
		expect((await h.api("GET", "/api/board")).body.projects).toEqual([]);
	});

	it("explains a missing base branch on the card instead of showing git's error, and recovers with Run again", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Todo app" })).body;
		// The branch Tower recorded for the project disappears (renamed, or the project predates this check).
		const git = (...args: string[]) => execFileSync("git", args, { cwd: h.repo, stdio: "pipe" });
		git("checkout", "-q", "-b", "trunk");
		git("branch", "-q", "-D", "main");

		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const stuck = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(stuck.status).toBe("needs_attention");
		expect(stuck.needsAttentionReason).toContain('Tower branches each card from "main"');
		expect(stuck.needsAttentionReason).not.toContain("Command failed");
		expect(h.driver.handles).toHaveLength(0);

		git("branch", "-q", "main");
		await h.api("POST", `/api/cards/${card.id}/retry`);
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card.status).toBe("awaiting_gate");
	});
});
