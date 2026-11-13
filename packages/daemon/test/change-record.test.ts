import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { firstTag, KIND, type NostrEvent, refs, verifyRecord } from "@tower/provenance";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const readEvents = (file: string): NostrEvent[] =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as NostrEvent);

describe("change record", () => {
	it("refuses a card that has no branch yet", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Not started" })).body;
		const response = await h.api("POST", `/api/cards/${card.id}/change`);
		expect(response.status).toBe(409);
		expect(response.body.error).toMatch(/no branch yet/);
	});

	it("seals the transcript, both gate verdicts, a margin note and the brief to the branch head", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add retry", brief: "Retry transient failures in the HTTP client." })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		// A person reads the plan, pins a note, and sends it back; then approves the second plan.
		expect((await h.api("POST", `/api/cards/${card.id}/annotations`, { artifact: "plan.md", quote: "Exponential backoff with jitter", note: "Cap it at 30 seconds." })).status).toBeLessThan(300);
		const first = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.at(-1);
		await h.api("POST", `/api/cards/${card.id}/gates/${first.id}`, { decision: "reject", feedback: "Cap the backoff." });
		await h.daemon.whenIdle();
		const second = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.at(-1);
		expect(second.id).not.toBe(first.id);
		await h.api("POST", `/api/cards/${card.id}/gates/${second.id}`, { decision: "approve" });
		await h.daemon.whenIdle();

		const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
		const head = execFileSync("git", ["rev-parse", detail.card.branchName], { cwd: h.repo, encoding: "utf8" }).trim();
		const root = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: h.repo, encoding: "utf8" }).trim();

		const response = await h.api("POST", `/api/cards/${card.id}/change`);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ commit: head, counts: { decisions: detail.gates.filter((g: { status: string }) => g.status !== "pending").length } });
		expect(response.body.published).toBeUndefined();

		const events = readEvents(response.body.file);
		expect(events).toHaveLength(response.body.counts.events);
		expect(verifyRecord(events)).toEqual([]);
		expect(events.every((event) => firstTag(event, "r") === root)).toBe(true);

		const keys = JSON.parse(readFileSync(join(h.home, "keys.json"), "utf8"));
		expect(statSync(join(h.home, "keys.json")).mode & 0o077).toBe(0);

		// The brief the work served.
		const direction = events.find((event) => event.kind === KIND.direction) as NostrEvent;
		expect(direction.content).toBe("# Add retry\n\nRetry transient failures in the HTTP client.");

		// Every run is a session whose turns chain; Tower's prompts and the agent's replies are the recorder's.
		const turns = events.filter((event) => event.kind === KIND.turn);
		const sessions = new Set(turns.map((turn) => firstTag(turn, "session")));
		for (const run of detail.runs) expect(sessions.has(`tower:${run.id}`)).toBe(true);
		const planned = turns.find((turn) => firstTag(turn, "role") === "agent" && turn.content === "Plan written.") as NostrEvent;
		expect(planned.pubkey).toBe(keys.scribe_pk);
		const prompt = turns.find((turn) => firstTag(turn, "role") === "prompt" && firstTag(turn, "session") === firstTag(planned, "session")) as NostrEvent;
		expect(refs(planned, "cause")).toEqual([prompt.id]);
		// Streaming deltas are not persisted, so the reply is recorded once, not once per frame.
		expect(turns.filter((turn) => firstTag(turn, "session") === firstTag(planned, "session") && turn.content === "Plan written.")).toHaveLength(1);

		// The margin note is the person's, signed with their key.
		const note = turns.find((turn) => firstTag(turn, "view") === "note") as NostrEvent;
		expect(note.pubkey).toBe(keys.human_pk);
		expect(JSON.parse(note.content)).toMatchObject({ artifact: "plan.md", quote: "Exponential backoff with jitter", note: "Cap it at 30 seconds." });

		// The rejection is a redirect with its reason, citing what the agent had said; the approval is a pick.
		const decisions = events.filter((event) => event.kind === KIND.decision);
		const rejected = decisions.find((event) => firstTag(event, "verdict") === "redirect") as NostrEvent;
		expect(rejected.pubkey).toBe(keys.human_pk);
		expect(JSON.parse(rejected.content)).toMatchObject({ question: "Approve this plan?", verdict: "redirect", picked: "reject" });
		expect(JSON.parse(rejected.content).why).toContain("Cap the backoff.");
		expect(firstTag(rejected, "gate")).toBe("plan_approval");
		const cited = events.find((event) => event.id === refs(rejected, "cites")[0]) as NostrEvent;
		expect(cited.content).toBe("Plan written.");
		expect(decisions.some((event) => firstTag(event, "verdict") === "pick")).toBe(true);

		// The change binds all of it to the commit.
		const change = events.find((event) => event.kind === KIND.change) as NostrEvent;
		expect(change.id).toBe(response.body.changeId);
		expect(change.pubkey).toBe(keys.human_pk);
		expect(firstTag(change, "commit")).toBe(head);
		expect(firstTag(change, "base")).toBe(detail.card.baseCommit);
		expect(firstTag(change, "attribution")).toBe("none");
		expect(refs(change, "direction")).toEqual([direction.id]);
		expect(refs(change, "decision").toSorted()).toEqual(decisions.map((event) => event.id).toSorted());
		expect(change.tags.filter((tag) => tag[0] === "transcript")).toHaveLength(sessions.size);
		expect(JSON.parse(change.content)).toMatchObject({ summary: "Add retry", counts: { lines_added: 2 }, trace: { vcs: { revision: head }, tool: { name: "tower" } } });

		// Sealing again changes nothing: ids depend only on what was recorded.
		const again = await h.api("POST", `/api/cards/${card.id}/change`);
		expect(again.body.changeId).toBe(change.id);
		expect(readEvents(again.body.file).map((event) => event.id)).toEqual(events.map((event) => event.id));
	});

	it("reports an unreachable relay without losing the record", async () => {
		h = await bootHarness(byStage());
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add feature" })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const response = await h.api("POST", `/api/cards/${card.id}/change`, { relay: "ws://127.0.0.1:1" });
		expect(response.status).toBe(200);
		expect(response.body.published).toMatchObject({ relay: "ws://127.0.0.1:1", accepted: 0 });
		expect(response.body.published.error).toMatch(/Could not reach the relay/);
		expect(existsSync(response.body.file)).toBe(true);
	});
});
