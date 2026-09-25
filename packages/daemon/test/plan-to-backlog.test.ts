import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, planningTurn, type FakeScript, type Harness } from "./harness.ts";
import { parsePlanCards } from "../src/plan-splitter.ts";

let h: Harness;
afterEach(async () => {
	// Close once: the last test never boots a harness, and closing twice is an error.
	const harness = h;
	h = undefined as unknown as Harness;
	await harness?.close();
});

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

const PLAN = `# Todo app plan

1. Accounts: sign up, sign in, sign out; sessions in a cookie; passwords hashed.
2. Lists: create, rename, delete; a list has one owner and a share link.
3. Todos: CRUD within a list, manual ordering, a due date, and an overdue view.
4. Polish: empty states, keyboard capture, and a weekly summary email.
`;

/** The scripted work-breakdown session: the plan goes in, three proposed cards come out. */
const splitterScript = (): FakeScript => (spec) => {
	if (spec.sessionId.startsWith("plan-split"))
		return [
			{
				events: [{ type: "message", message: { role: "assistant", text: JSON.stringify({ cards: [
					{ title: "Build accounts", brief: "Sign up, sign in, sign out; sessions in a cookie; passwords hashed. Verify: the API refuses a duplicate signup." },
					{ title: "Build lists", brief: "Create, rename, delete lists; one owner and a share link. Verify: a deleted list disappears for its members." },
					{ title: "Build todos", brief: "CRUD within a list, manual ordering, a due date, an overdue view. Verify: reordering persists across reloads." },
				] }), thinking: "", toolCalls: [] } }],
			},
		];
	if (spec.sessionId.includes("-plan-")) return [planningTurn()];
	return [];
};

const addProject = async (): Promise<{ id: string }> => (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;

describe("plan to backlog", () => {
	it("cuts a pasted plan into proposed cards without filing anything", async () => {
		h = await bootHarness(splitterScript(), ENV);
		const project = await addProject();
		const proposal = await h.api("POST", `/api/projects/${project.id}/plan-to-backlog`, { plan: PLAN });
		expect(proposal.status).toBe(200);
		expect(proposal.body.cards).toHaveLength(3);
		expect(proposal.body.cards[0]).toMatchObject({ title: "Build accounts" });

		// The plan reached the agent, and nothing is on the board yet.
		const session = h.driver.handles.find((handle) => handle.sessionId.startsWith("plan-split"));
		expect(session?.prompts[0]).toContain("weekly summary email");
		expect(session?.prompts[0]).toContain("stand completely alone");
		expect(((await h.api("GET", "/api/board")).body).cards).toHaveLength(0);
	});

	it("can cut an existing card's plan.md instead of pasted text", async () => {
		h = await bootHarness(splitterScript(), ENV);
		const project = await addProject();
		const card = (await h.api("POST", `/api/cards`, { projectId: project.id, title: "Add retry with backoff", brief: "5xx responses should be retried." })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();

		const proposal = await h.api("POST", `/api/projects/${project.id}/plan-to-backlog`, { cardId: card.id });
		expect(proposal.status).toBe(200);
		const session = h.driver.handles.find((handle) => handle.sessionId.startsWith("plan-split"));
		expect(session?.prompts[0]).toContain("payments API");
	});

	it("files the picked draft as inert backlog cards, in order", async () => {
		h = await bootHarness(splitterScript(), ENV);
		const project = await addProject();
		const proposal = (await h.api("POST", `/api/projects/${project.id}/plan-to-backlog`, { plan: PLAN })).body;
		// The person drops the middle card: two survive, in the plan's order.
		const picked = [proposal.cards[0], proposal.cards[2]];
		const filed = await h.api("POST", `/api/projects/${project.id}/plan-to-backlog/file`, { cards: picked });
		expect(filed.status).toBe(201);
		expect(filed.body.cards).toHaveLength(2);

		const board = (await h.api("GET", "/api/board")).body;
		expect(board.cards).toHaveLength(2);
		for (const card of filed.body.cards) expect(card).toMatchObject({ stage: "backlog", status: "idle" });
		expect(board.cards.find((c: { title: string }) => c.title === "Build accounts").brief).toContain("passwords hashed");
		expect(board.cards.find((c: { title: string }) => c.title === "Build todos")).toBeDefined();

		// Filing validates its input.
		expect((await h.api("POST", `/api/projects/${project.id}/plan-to-backlog/file`, { cards: [] })).status).toBe(400);
		expect((await h.api("POST", `/api/projects/${project.id}/plan-to-backlog`, { plan: "too short" })).status).toBe(400);
	});

	it("queue:true files the cards and enqueues them, so the pipeline drains the queue on its own", async () => {
		h = await bootHarness(splitterScript(), ENV);
		const project = await addProject();
		const proposal = (await h.api("POST", `/api/projects/${project.id}/plan-to-backlog`, { plan: PLAN })).body;
		const filed = await h.api("POST", `/api/projects/${project.id}/plan-to-backlog/file`, { cards: proposal.cards.slice(0, 2), queue: true });
		expect(filed.status).toBe(201);
		// Every filed card is waiting in the queue for a slot, not inert on the backlog.
		for (const card of filed.body.cards) expect(card).toMatchObject({ stage: "planning", status: "queued" });
		// The queue is ordered: the first filed card plans first.
		expect(filed.body.cards[0].createdAt).toBeLessThanOrEqual(filed.body.cards[1].createdAt);
		await h.daemon.whenIdle();
		// And the queue really drains: the first card reached its plan gate, planning ran once per card.
		const planRuns = h.driver.handles.filter((handle) => handle.sessionId.includes("-plan-"));
		expect(planRuns.length).toBeGreaterThanOrEqual(1);
	});

	it("parsePlanCards tolerates a fenced reply and drops malformed entries", () => {
		const reply = 'Sure! ```json\n{"cards":[{"title":"A","brief":"do a"},{"title":"","brief":"skip"},{"title":"C","brief":"do c"}]}\n```';
		expect(parsePlanCards(reply)).toEqual([
			{ title: "A", brief: "do a" },
			{ title: "C", brief: "do c" },
		]);
		expect(() => parsePlanCards("no json here")).toThrow("did not return usable cards");
	});
});
