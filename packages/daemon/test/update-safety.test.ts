import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";
import { SCHEMA_VERSION } from "../src/db/migrate.ts";
import { openDb } from "../src/db/open.ts";
import { getProject, updateProject } from "../src/db/repo-projects.ts";
import { getCard } from "../src/db/repo-cards.ts";

let h: Harness;
afterEach(async () => h?.close());

describe("updating while jobs are in play", () => {
	it("migrates a database from the previous version in place and keeps its projects and cards", () => {
		const dir = mkdtempSync(join(tmpdir(), "tower-upgrade-"));
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const old = new DatabaseSync(join(dir, "tower.sqlite"));
		// The projects and cards tables exactly as version 5 shipped them: no invariant_simulation yet, no issue provenance.
		old.exec(`
			CREATE TABLE projects (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				repo_path TEXT NOT NULL UNIQUE,
				default_branch TEXT NOT NULL,
				setup_command TEXT,
				verify_command TEXT,
				trust_project_pi INTEGER NOT NULL DEFAULT 0,
				extensions_json TEXT NOT NULL DEFAULT '[]',
				concurrency_limit INTEGER NOT NULL DEFAULT 1,
				stage_config_json TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL
			);
			ALTER TABLE projects ADD COLUMN review_flows_json TEXT;
			INSERT INTO projects (id, name, repo_path, default_branch, verify_command, concurrency_limit, created_at)
				VALUES ('oldpro1', 'older', '/tmp/older', 'main', 'pnpm test', 2, 1);
			CREATE TABLE cards (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(id),
				title TEXT NOT NULL,
				brief TEXT NOT NULL DEFAULT '',
				stage TEXT NOT NULL DEFAULT 'backlog',
				status TEXT NOT NULL DEFAULT 'idle',
				priority INTEGER NOT NULL DEFAULT 0,
				position REAL NOT NULL DEFAULT 0,
				branch_name TEXT,
				worktree_path TEXT,
				base_commit TEXT,
				attempt INTEGER NOT NULL DEFAULT 0,
				stage_config_json TEXT NOT NULL DEFAULT '{}',
				pr_url TEXT,
				pr_state TEXT,
				needs_attention_reason TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			ALTER TABLE cards ADD COLUMN queued_effect_json TEXT;
			ALTER TABLE cards ADD COLUMN queued_at INTEGER;
			INSERT INTO cards (id, project_id, title, brief, stage, status, priority, position, attempt, created_at, updated_at)
				VALUES ('oldcard1', 'oldpro1', 'Older card', 'Done long ago.', 'done', 'idle', 0, 0, 0, 1, 1);
			PRAGMA user_version = 5;
		`);
		old.close();

		const db = openDb(join(dir, "tower.sqlite"));
		onTestFinished(() => db.close());
		// The fixture is one version back; migrating takes it to whatever "current" is, whenever this test runs.
		expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
		const project = getProject(db, "oldpro1");
		expect(project).toMatchObject({ name: "older", verifyCommand: "pnpm test", reviewFlows: null, invariantSimulation: null });
		// The new setting works on the migrated row, in both directions.
		expect(updateProject(db, "oldpro1", { invariantSimulation: false }).invariantSimulation).toBe(false);
		expect(updateProject(db, "oldpro1", { invariantSimulation: null }).invariantSimulation).toBe(null);
		// The card row survives, and the issue columns it never had read as "not from intake".
		expect(getCard(db, "oldcard1")).toMatchObject({ title: "Older card", brief: "Done long ago.", issueNumber: null, issueUrl: null, issueAuthor: null });
	});

	it("a stage that meets prompt files newer than the daemon fails cleanly and recovers on retry", async () => {
		// The update-skew window: Tower's files were refreshed while the daemon still runs the previous
		// version, and prompt templates are read from disk per run — the next stage sees the new files.
		const dir = mkdtempSync(join(tmpdir(), "tower-prompts-"));
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		mkdirSync(join(dir, "partials"), { recursive: true });
		writeFileSync(join(dir, "partials", "stage-result-contract.md"), "Write the result file.");
		writeFileSync(join(dir, "partials", "invariant-protocol.md"), "The method.");
		writeFileSync(
			join(dir, "planning.md"),
			"Plan {{title}} at {{planPath}}.\n{{> invariant-protocol}}\n{{> a-partial-this-daemon-does-not-know}}\n{{> stage-result-contract}}",
		);
		h = await bootHarness(byStage(), { TOWER_PROMPTS_DIR: dir });
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add retries" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		const failed = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(failed.card).toMatchObject({ stage: "planning", status: "needs_attention" });
		expect(failed.card.needsAttentionReason).toContain("could not be rendered");
		expect(failed.card.needsAttentionReason).toContain("restart the daemon");
		// Nothing was spawned for the failed run, so nothing is wedged or holding a slot.
		expect(h.driver.handles).toHaveLength(0);

		// The update lands (the file is now consistent with the daemon); retry runs the stage as normal.
		writeFileSync(join(dir, "planning.md"), "Plan the thing.\n{{> invariant-protocol}}\n{{> stage-result-contract}}");
		await h.api("POST", `/api/cards/${card.id}/retry`);
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "planning", status: "awaiting_gate" });
		expect(h.driver.handles[0]?.prompts[0]).toContain("Plan the thing.");
	});
});
