import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, type FakeScript, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0", TOWER_ISSUES_POLL_MS: "0" };

/** A scripted intent session whose reply is `text`; keyed on the assist session id so stages fall through. */
function intentReply(text: string): FakeScript {
	return (spec) => (spec.sessionId.includes("assist") ? [{ events: [{ type: "message", message: { role: "assistant", text, thinking: "", toolCalls: [] } }] }] : []);
}

function makeRepo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	writeFileSync(`${dir}/README.md`, "# x\n");
	git("add", ".");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
	return dir;
}

describe("the command box ask", () => {
	it("reads a tagged line and files a card on that project", async () => {
		h = await bootHarness(intentReply('{"action":"add_card","project":"axiom","title":"Fix the retry loop","brief":"5xx retries drop attempts."}'), ENV);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		// The board name is the directory's basename until it is set; the verdict names it "axiom".
		await h.api("PATCH", `/api/projects/${project.id}`, { name: "axiom" });
		const res = await h.api("POST", "/api/assist", { text: "fix the retry loop @axiom" });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, action: "add_card", projectId: project.id, card: { title: "Fix the retry loop", stage: "backlog", status: "idle" } });
		expect(res.body.reply).toContain("backlog");
		// The reader saw the line and the project list, and got no tools — it only reads.
		const session = h.driver.handles.find((handle) => handle.sessionId.includes("assist"));
		expect(session?.prompts[0]).toContain("fix the retry loop @axiom");
		expect(session?.prompts[0]).toContain("Projects on this board: axiom");
		expect(session?.spec.tools).toEqual([]);
		expect(session?.spec.thinking).toBe("off");
		expect(session?.spec.model).toBe("zai/glm-5.3");
	});

	it("can start the work it read, planning as soon as a slot allows", async () => {
		h = await bootHarness(intentReply('{"action":"start_card","project":"axiom","title":"Ship a dry-run flag","brief":""}'), ENV);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		await h.api("PATCH", `/api/projects/${project.id}`, { name: "axiom" });
		const res = await h.api("POST", "/api/assist", { text: "start on axiom: ship a dry-run flag" });
		expect(res.body).toMatchObject({ ok: true, action: "start_card" });
		expect(["queued", "running"]).toContain(res.body.card.status);
	});

	it("acts on nobody's behalf when the line is not work", async () => {
		h = await bootHarness(intentReply('{"action":"none","project":"","title":"","brief":""}'), ENV);
		await h.api("POST", "/api/projects", { repoPath: h.repo });
		const res = await h.api("POST", "/api/assist", { text: "hello there" });
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(false);
		expect(res.body.reply).toContain("did not read as work");
		expect((await h.api("GET", "/api/board")).body.cards).toHaveLength(0);
	});

	it("with one project, an unnamed verdict still knows where to go", async () => {
		h = await bootHarness(intentReply('{"action":"add_card","project":"","title":"Tighten the files allowlist","brief":""}'), ENV);
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const res = await h.api("POST", "/api/assist", { text: "tighten the npm files allowlist" });
		expect(res.body).toMatchObject({ ok: true, projectId: project.id, card: { title: "Tighten the files allowlist" } });
	});

	it("asks which project when neither the read nor the tag names one", async () => {
		h = await bootHarness(intentReply('{"action":"add_card","project":"","title":"Mystery work","brief":""}'), ENV);
		await h.api("POST", "/api/projects", { repoPath: h.repo });
		await h.api("POST", "/api/projects", { repoPath: makeRepo(`${h.home}/../second`) });
		const res = await h.api("POST", "/api/assist", { text: "file this somewhere @nowhere" });
		expect(res.body.ok).toBe(false);
		expect(res.body.reply).toContain("Which project?");
		expect((await h.api("GET", "/api/board")).body.cards).toHaveLength(0);
	});

	it("when the intent session fails, a tagged line is still filed as-is on the tagged project", async () => {
		h = await bootHarness(intentReply("I am not sure what you mean — no JSON today."), ENV);
		await h.api("POST", "/api/projects", { repoPath: h.repo });
		const second = (await h.api("POST", "/api/projects", { repoPath: makeRepo(`${h.home}/../second`) })).body;
		const res = await h.api("POST", "/api/assist", { text: "print what would be deleted @second" });
		expect(res.body).toMatchObject({ ok: true, projectId: second.id, card: { title: "print what would be deleted" } });
		expect(res.body.reply).toContain("as-is");
	});
});
