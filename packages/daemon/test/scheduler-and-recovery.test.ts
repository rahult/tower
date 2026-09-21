import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness, planningTurn } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

/** A second git repo next to the harness's first one. */
function secondRepo(harness: Harness): string {
	const repo = join(harness.home, "..", "repo-b");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "README.md"), "# b\n");
	git("add", ".");
	git("-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "init");
	return repo;
}

const statuses = async (harness: Harness) => {
	const board = (await harness.api("GET", "/api/board")).body;
	return Object.fromEntries(board.cards.map((card: { title: string; status: string }) => [card.title, card.status]));
};

async function until(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not reached in time");
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

describe("scheduler", () => {
	it("runs at most the global cap at once and one card per project by default, then drains the queue", async () => {
		h = await bootHarness(() => [planningTurn({ delayMs: 25 })], { TOWER_MAX_CONCURRENT: "2" });
		const a = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const b = (await h.api("POST", "/api/projects", { repoPath: secondRepo(h) })).body;
		for (const [project, title] of [[a, "a1"], [a, "a2"], [b, "b1"], [b, "b2"]] as const) {
			const card = (await h.api("POST", "/api/cards", { projectId: project.id, title })).body;
			await h.api("POST", `/api/cards/${card.id}/enqueue`);
		}

		// Oldest first, one per project: a1 and b1 run, a2 and b2 wait.
		await until(async () => Object.values(await statuses(h)).filter((s) => s === "running").length === 2);
		expect(await statuses(h)).toEqual({ a1: "running", a2: "queued", b1: "running", b2: "queued" });

		await h.daemon.whenIdle();
		expect(await statuses(h)).toEqual({ a1: "awaiting_gate", a2: "awaiting_gate", b1: "awaiting_gate", b2: "awaiting_gate" });
		// Never more than two sessions alive at the same moment.
		expect(h.driver.handles).toHaveLength(4);
	});

	it("a raised project limit lets two of its cards run side by side, each in its own worktree", async () => {
		h = await bootHarness(() => [planningTurn({ delayMs: 25 })]);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		expect((await h.api("PATCH", `/api/projects/${project.id}`, { concurrencyLimit: 0 })).status).toBe(400);
		await h.api("PATCH", `/api/projects/${project.id}`, { concurrencyLimit: 2 });
		for (const title of ["one", "two"]) {
			const card = (await h.api("POST", "/api/cards", { projectId: project.id, title })).body;
			await h.api("POST", `/api/cards/${card.id}/enqueue`);
		}
		await until(async () => Object.values(await statuses(h)).every((s) => s === "running"));
		const [first, second] = h.driver.handles;
		expect(first?.spec.cwd).not.toBe(second?.spec.cwd);
		await h.daemon.whenIdle();
	});

	it("takes a waiting card off the queue when it is aborted", async () => {
		h = await bootHarness(() => [planningTurn({ delayMs: 40 })]);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const ids: string[] = [];
		for (const title of ["first", "second"]) {
			const card = (await h.api("POST", "/api/cards", { projectId: project.id, title })).body;
			ids.push(card.id);
			await h.api("POST", `/api/cards/${card.id}/enqueue`);
		}
		await until(async () => (await statuses(h)).first === "running");
		expect((await h.api("POST", `/api/cards/${ids[1]}/abort`)).status).toBe(200);
		await h.daemon.whenIdle();
		expect(await statuses(h)).toEqual({ first: "awaiting_gate", second: "idle" });
		expect(h.driver.handles).toHaveLength(1);
	});
});

describe("restart recovery", () => {
	it("marks in-flight work interrupted, keeps the queue, and resumes the same session", async () => {
		h = await bootHarness(() => [{ events: [{ type: "text", delta: "thinking about it" }], hang: true }]);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const running = (await h.api("POST", "/api/cards", { projectId: project.id, title: "running" })).body;
		const waiting = (await h.api("POST", "/api/cards", { projectId: project.id, title: "waiting" })).body;
		await h.api("POST", `/api/cards/${running.id}/enqueue`);
		await h.api("POST", `/api/cards/${waiting.id}/enqueue`);
		await until(async () => (await statuses(h)).running === "running");

		// After the restart, sessions behave: the interrupted one can finish, the queued one runs.
		await h.restart(byStage());
		await h.daemon.whenIdle();

		const interrupted = (await h.api("GET", `/api/cards/${running.id}`)).body;
		expect(interrupted.card).toMatchObject({ stage: "planning", status: "interrupted" });
		expect(interrupted.runs[0]).toMatchObject({ id: `c${running.id}-plan-1`, status: "interrupted" });
		// The interrupted card no longer holds the project's slot, so the queued card ran to its gate.
		expect((await statuses(h)).waiting).toBe("awaiting_gate");

		expect((await h.api("POST", `/api/cards/${running.id}/resume`)).body).toMatchObject({ status: "queued" });
		await h.daemon.whenIdle();
		const resumed = (await h.api("GET", `/api/cards/${running.id}`)).body;
		expect(resumed.card.status).toBe("awaiting_gate");
		// Same run, same session id: pi restores the conversation; no second planning attempt was created.
		expect(resumed.runs).toHaveLength(1);
		expect(resumed.runs[0]).toMatchObject({ id: `c${running.id}-plan-1`, status: "settled", resultStatus: "pass" });
		const session = h.driver.handles.find((handle) => handle.sessionId === `c${running.id}-plan-1`);
		expect(session?.prompts[0]).toContain("interrupted by a restart");

		// One continuous transcript across the restart: seq keeps counting, nothing repeats.
		const items = (await h.api("GET", `/api/runs/c${running.id}-plan-1/transcript`)).body.items;
		const seqs: number[] = items.map((item: { seq: number }) => item.seq);
		expect(seqs).toEqual([...new Set(seqs)].sort((x, y) => x - y));
		expect(items.map((item: { type: string }) => item.type)).toEqual(expect.arrayContaining(["prompt", "resumed", "run_finished"]));
	});

	it("an interrupted card can start its stage over instead of resuming", async () => {
		h = await bootHarness(() => [{ events: [], hang: true }]);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await until(async () => (await statuses(h)).x === "running");
		await h.restart(byStage());

		expect((await h.api("POST", `/api/cards/${card.id}/retry`)).status).toBe(202);
		await h.daemon.whenIdle();
		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		expect(detail.runs.map((run: { id: string; status: string }) => [run.id, run.status])).toEqual([
			[`c${card.id}-plan-1`, "interrupted"],
			[`c${card.id}-plan-2`, "settled"],
		]);
	});

	it("refuses to resume a card that was not interrupted", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "x" })).body;
		expect((await h.api("POST", `/api/cards/${card.id}/resume`)).status).toBe(409);
	});
});
