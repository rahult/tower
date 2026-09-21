import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

describe("repositories Tower cannot branch from", () => {
	it("starts a brand-new repository off with an empty first commit, leaving the user's files and index alone", async () => {
		h = await bootHarness(byStage());
		const fresh = join(h.home, "..", "fresh");
		mkdirSync(fresh, { recursive: true });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: fresh, encoding: "utf8" }).trim();
		git("init", "-q", "-b", "main");
		writeFileSync(join(fresh, "staged.txt"), "staged by the user\n");
		writeFileSync(join(fresh, "notes.txt"), "untracked\n");
		git("add", "staged.txt");

		const project = await h.api("POST", "/api/projects", { repoPath: fresh });
		expect(project.status).toBe(201);
		expect(git("rev-list", "--count", "main")).toBe("1");
		// An empty tree: nothing of the user's was committed on their behalf.
		expect(git("ls-tree", "-r", "main")).toBe("");
		expect(git("log", "-1", "--format=%s")).toContain("Initial commit");
		expect(execFileSync("git", ["status", "--porcelain"], { cwd: fresh, encoding: "utf8" })).toBe("A  staged.txt\n?? notes.txt\n");

		const card = (await h.api("POST", "/api/cards", { projectId: project.body.id, title: "Todo app" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ status: "awaiting_gate", needsAttentionReason: null });
	});

	it("does the same for a project that was added while its repository was still empty", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Todo app" })).body;
		// Put the repository back into the state `git init` leaves it in: HEAD names main, main has no commit.
		execFileSync("git", ["update-ref", "-d", "refs/heads/main"], { cwd: h.repo });

		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ status: "awaiting_gate", needsAttentionReason: null });
		expect(execFileSync("git", ["rev-list", "--count", "main"], { cwd: h.repo, encoding: "utf8" }).trim()).toBe("1");
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
