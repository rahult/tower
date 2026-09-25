import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness, reviewTurn } from "./harness.ts";

let h: Harness;
const originalPath = process.env.PATH;
afterEach(async () => {
	await h?.close();
	process.env.PATH = originalPath;
});

const FLOWS = { TOWER_REVIEW_FLOWS: "adversarial-review,solid-review" };
const VERIFY = "true";

/** Drives a card to the feedback gate and returns it with its pending gate. */
async function toFeedbackGate(harness: Harness) {
	const project = (await harness.api("POST", "/api/projects", { repoPath: harness.repo })).body;
	await harness.api("PATCH", `/api/projects/${project.id}`, { verifyCommand: VERIFY });
	const card = (await harness.api("POST", "/api/cards", { projectId: project.id, title: "Add feature", brief: "Make it so." })).body;
	await harness.api("POST", `/api/cards/${card.id}/enqueue`);
	await harness.daemon.whenIdle();
	const plan = (await harness.api("GET", `/api/cards/${card.id}`)).body.gates[0];
	await harness.api("POST", `/api/cards/${card.id}/gates/${plan.id}`, { decision: "approve" });
	await harness.daemon.whenIdle();
	const detail = (await harness.api("GET", `/api/cards/${card.id}`)).body;
	return { card, project, detail, gate: detail.gates.find((g: { status: string }) => g.status === "pending") };
}

/** A fake `gh` on PATH whose pull request lives in a JSON file the test can edit, plus a local bare repo as origin. */
function fakeGitHub(harness: Harness) {
	const dir = join(harness.home, "..", "fake-gh");
	mkdirSync(dir, { recursive: true });
	const state = join(dir, "state.json");
	writeFileSync(state, JSON.stringify({ pr: null, calls: [] }));
	writeFileSync(
		join(dir, "gh"),
		`#!/usr/bin/env node
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
if (args[0] === "pr" && args[1] === "view") {
	if (!state.pr) { fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state)); console.error("no pull requests found for branch"); process.exit(1); }
	console.log(JSON.stringify(state.pr));
} else if (args[0] === "pr" && args[1] === "create") {
	state.pr = { url: "https://github.com/acme/repo/pull/7", state: "OPEN", headRefOid: "sha-1", statusCheckRollup: [] };
	state.body = fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8");
	console.log(state.pr.url);
} else { console.error("unexpected gh call: " + args.join(" ")); process.exit(2); }
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
`,
	);
	chmodSync(join(dir, "gh"), 0o755);
	process.env.PATH = `${dir}:${originalPath}`;
	const remote = join(harness.home, "..", "origin.git");
	execFileSync("git", ["init", "-q", "--bare", remote]);
	execFileSync("git", ["remote", "add", "origin", remote], { cwd: harness.repo });
	return {
		remote,
		read: () => JSON.parse(readFileSync(state, "utf8")),
		setPr: (patch: Record<string, unknown>) => {
			const current = JSON.parse(readFileSync(state, "utf8"));
			writeFileSync(state, JSON.stringify({ ...current, pr: { ...current.pr, ...patch } }));
		},
	};
}

describe("review flows and the feedback gate", () => {
	it("runs the project's review flows in fresh, read-only sessions on the expensive tier, then waits for the human", async () => {
		h = await bootHarness(byStage(), FLOWS);
		const { card, detail, gate } = await toFeedbackGate(h);
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		expect(gate).toMatchObject({ kind: "feedback", status: "pending" });

		const reviews = h.driver.handles.filter((handle) => handle.sessionId.includes("-review-"));
		expect(reviews.map((handle) => handle.sessionId)).toEqual([`c${card.id}-adversarial-review-1`, `c${card.id}-solid-review-1`]);
		for (const review of reviews) {
			expect(review.spec.model).toBe("anthropic/claude-fable-5-1");
			expect(review.spec.tools).not.toContain("edit");
			expect(review.prompts[0]).toContain("Do not modify the repository");
			expect(review.prompts[0]).toContain("stage-result.json");
			expect(review.prompts[0]).not.toMatch(/\{\{/);
		}
		expect(reviews[0]?.spec.tools).toContain("bash");
		expect(reviews[0]?.prompts[0]).toContain("adversarial reviewer");
		expect(reviews[1]?.prompts[0]).toContain("SOLID");

		expect(detail.artifacts.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(["reviews/adversarial-review.md", "reviews/solid-review.md"]));
		expect((await h.api("GET", `/api/cards/${card.id}/artifacts/reviews%2Fsolid-review.md`)).body).toContain("One finding.");
		expect((await h.api("GET", `/api/cards/${card.id}/artifacts/sessions%2Fx`)).status).toBe(404);
		expect((await h.api("GET", `/api/cards/${card.id}/artifacts/reviews%2F..%2Ftower.sqlite`)).status).toBe(404);
	});

	it("sending the work back rebuilds with the feedback, then reviews again", async () => {
		h = await bootHarness(byStage(), FLOWS);
		const { card, gate } = await toFeedbackGate(h);
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "reject", feedback: "Fix the blocking finding in reviews/adversarial-review.md" });
		await h.daemon.whenIdle();
		const rebuild = h.driver.handles.find((handle) => handle.sessionId === `c${card.id}-build-2`);
		expect(rebuild?.prompts[0]).toContain("Fix the blocking finding");
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
		expect(h.driver.handles.filter((handle) => handle.sessionId.includes("-adversarial-review-"))).toHaveLength(2);
	});

	it("a card resting on a passing test continues to review without testing again", async () => {
		h = await bootHarness(byStage(), FLOWS);
		const { card } = await toFeedbackGate(h);
		// Put it back where an older Tower left such cards: tested, passed, resting.
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(join(h.home, "tower.sqlite"));
		db.prepare("UPDATE cards SET stage = 'testing', status = 'idle' WHERE id = ?").run(card.id);
		db.prepare("UPDATE gates SET status = 'approved' WHERE card_id = ?").run(card.id);
		db.close();
		const sessions = h.driver.handles.length;

		expect((await h.api("POST", `/api/cards/${card.id}/retry`)).body).toMatchObject({ stage: "feedback", status: "queued" });
		await h.daemon.whenIdle();
		const started = h.driver.handles.slice(sessions).map((handle) => handle.sessionId.replace(`c${card.id}-`, ""));
		expect(started).toEqual(["adversarial-review-2", "solid-review-2"]);
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "feedback", status: "awaiting_gate" });
	});

	it("a project can turn reviews off, or choose which run", async () => {
		h = await bootHarness(byStage(), FLOWS);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		expect((await h.api("PATCH", `/api/projects/${project.id}`, { reviewFlows: ["no-such-flow"] })).status).toBe(400);
		expect((await h.api("PATCH", `/api/projects/${project.id}`, { reviewFlows: ["solid-review"] })).body.reviewFlows).toEqual(["solid-review"]);
		expect((await h.api("GET", "/api/flows")).body.flows.map((flow: { name: string }) => flow.name)).toEqual(["acceptance-green", "acceptance-red", "adversarial-review", "deep-research", "invariant-simulation", "plan-coach", "solid-review", "understand-system"]);
	});
});

describe("pull requests", () => {
	it("without origin, approval merges the branch into the default branch locally", async () => {
		h = await bootHarness(byStage());
		const { project, card, detail, gate } = await toFeedbackGate(h);
		expect(project.hasOrigin).toBe(false);
		// The checkout moves on while the card works: the merge has to be a real one, not a fast-forward.
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "docs"], { cwd: h.repo });
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const done = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(done).toMatchObject({ stage: "done", status: "idle", prUrl: null });
		// The merge is an outcome, not an attention reason: it lands in finishNote with the reason cleared.
		expect(done.finishNote).toContain("Merged into main locally");
		expect(done.needsAttentionReason).toBeNull();
		expect(existsSync(detail.card.worktreePath)).toBe(false);
		// The work landed on main as a real merge commit, and the card branch left with its worktree.
		const log = execFileSync("git", ["log", "--oneline", "main"], { cwd: h.repo, encoding: "utf8" });
		expect(log).toContain("Add feature");
		expect(log).toContain("docs");
		expect(log).toMatch(/Merge branch '.*' \(card/);
		expect(execFileSync("git", ["branch", "--list", done.branchName], { cwd: h.repo, encoding: "utf8" })).toBe("");
	});

	it("approving past a blocking review needs eyes: the acknowledgment is required", async () => {
		// The adversarial review finds something blocking; the flow still finishes (its verdict is a
		// finding, not a crash) and the gate opens — but approve now demands the acknowledgment.
		h = await bootHarness((spec) => {
			if (spec.sessionId.includes("adversarial-review")) return [reviewTurn("fail")];
			return byStage()(spec);
		}, FLOWS);
		const { card, gate } = await toFeedbackGate(h);
		expect(gate.kind).toBe("feedback");

		const refused = await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toContain("blocking");
		expect(refused.body.error).toContain("acknowledgeBlocking");

		const approved = await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve", acknowledgeBlocking: true });
		expect(approved.status).toBe(200);
	});

	it("a done card can be deleted from the board, and a live one cannot", async () => {
		h = await bootHarness(byStage());
		const { project, card, gate } = await toFeedbackGate(h);
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "done" });

		const deleted = await h.api("DELETE", `/api/cards/${card.id}`);
		expect(deleted.status).toBe(200);
		expect((await h.api("GET", `/api/cards/${card.id}`)).status).toBe(404);
		const board = (await h.api("GET", "/api/board")).body;
		expect(board.cards.find((candidate: { id: string }) => candidate.id === card.id)).toBeUndefined();

		// A card with work in flight refuses: hygiene never touches live work.
		const live = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Second" })).body;
		await h.api("POST", `/api/cards/${live.id}/enqueue`);
		expect((await h.api("DELETE", `/api/cards/${live.id}`)).status).toBe(409);
		await h.daemon.whenIdle();
	});

	it("a dirty checkout stops the merge until it is clean, then Retry finishes the card", async () => {
		h = await bootHarness(byStage());
		const { card, gate } = await toFeedbackGate(h);
		writeFileSync(join(h.repo, "scratch.txt"), "mine");
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const stuck = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(stuck).toMatchObject({ stage: "pull_request", status: "needs_attention" });
		expect(stuck.needsAttentionReason).toContain("uncommitted changes");
		expect(stuck.needsAttentionReason).toContain("Retry");

		unlinkSync(join(h.repo, "scratch.txt"));
		await h.api("POST", `/api/cards/${card.id}/retry`);
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "done", status: "idle" });
		expect(execFileSync("git", ["log", "--oneline", "main"], { cwd: h.repo, encoding: "utf8" })).toContain("Add feature");
	});

	it("when the default branch is checked out nowhere, the merge still lands without touching the checkout", async () => {
		h = await bootHarness(byStage());
		const { card, gate } = await toFeedbackGate(h);
		// Diverge main, then leave it checked out nowhere: the merge has to happen through plumbing.
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "docs"], { cwd: h.repo });
		execFileSync("git", ["checkout", "-q", "-b", "side"], { cwd: h.repo });
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "done", status: "idle" });
		// main moved; the person's checkout did not.
		expect(execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: h.repo, encoding: "utf8" }).trim()).toBe("side");
		expect(execFileSync("git", ["status", "--porcelain"], { cwd: h.repo, encoding: "utf8" })).toBe("");
		const log = execFileSync("git", ["log", "--oneline", "main"], { cwd: h.repo, encoding: "utf8" });
		expect(log).toContain("Add feature");
		expect(log).toContain("docs");
		expect(log).toMatch(/Merge branch '.*' \(card/);
	});

	it("pushes the branch, opens the pull request non-interactively, and finishes when it is merged", async () => {
		h = await bootHarness(byStage());
		const github = fakeGitHub(h);
		const { project, card, detail, gate } = await toFeedbackGate(h);
		expect(project.hasOrigin).toBe(true);
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();

		const opened = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(opened).toMatchObject({ stage: "pull_request", status: "idle", prUrl: "https://github.com/acme/repo/pull/7" });
		expect(execFileSync("git", ["branch", "--list", opened.branchName], { cwd: github.remote, encoding: "utf8" })).toContain(opened.branchName);
		const create = github.read().calls.find((call: string[]) => call[1] === "create");
		expect(create).toEqual(expect.arrayContaining(["--title", "Add feature", "--base", "main", "--head", opened.branchName, "--body-file"]));
		expect(github.read().body).toContain("Make it so.");
		expect(github.read().body).toContain("Built.");

		await h.daemon.pollPullRequests();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card.stage).toBe("pull_request");

		github.setPr({ state: "MERGED" });
		await h.daemon.pollPullRequests();
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "done", status: "idle" });
		expect(existsSync(detail.card.worktreePath)).toBe(false);
	});

	it("hands failing CI to a builder once per commit, pushes the fix, and stops at the cap", async () => {
		h = await bootHarness(byStage(), { TOWER_MAX_CI_FIX_ATTEMPTS: "1" });
		const github = fakeGitHub(h);
		const { card, gate } = await toFeedbackGate(h);
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();

		github.setPr({ statusCheckRollup: [{ name: "lint", conclusion: "FAILURE", detailsUrl: "https://ci/1" }, { name: "test", conclusion: "SUCCESS" }] });
		await h.daemon.pollPullRequests();
		await h.daemon.pollPullRequests();
		await h.daemon.whenIdle();
		const fixes = h.driver.handles.filter((handle) => handle.sessionId.includes("-cifix-"));
		expect(fixes).toHaveLength(1);
		expect(fixes[0]?.prompts[0]).toContain("lint (https://ci/1)");
		expect(fixes[0]?.prompts[0]).toContain("already in a pull request");
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ stage: "pull_request", status: "idle" });
		expect(github.read().calls.filter((call: string[]) => call[1] === "create")).toHaveLength(1);

		// The fix did not help (new commit, still red): at the cap, ask the person instead of looping.
		github.setPr({ headRefOid: "sha-2" });
		await h.daemon.pollPullRequests();
		await h.daemon.whenIdle();
		const stuck = (await h.api("GET", `/api/cards/${card.id}`)).body.card;
		expect(stuck.status).toBe("needs_attention");
		expect(stuck.needsAttentionReason).toContain("CI is still failing after 1 repair attempts: lint");
	});

	it("asks for attention when the pull request is closed unmerged, and explains a push that fails", async () => {
		h = await bootHarness(byStage());
		const github = fakeGitHub(h);
		const { card, gate } = await toFeedbackGate(h);
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		github.setPr({ state: "CLOSED" });
		await h.daemon.pollPullRequests();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card).toMatchObject({ status: "needs_attention", needsAttentionReason: "The pull request was closed without being merged." });
	});
});
