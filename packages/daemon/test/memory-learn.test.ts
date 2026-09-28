import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STAGE_RESULT_FILE } from "@tower/core";
import { bootHarness, buildingTurn, planningTurn, reviewTurn, testerTurn, type FakeScript, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const ENV = { TOWER_REVIEW_FLOWS: "", TOWER_PR_POLL_MS: "0" };

/** The harness repo becomes a small todo app: an API over an in-memory store, one invariant. */
function seedTodoApp(): void {
	writeFileSync(join(h.repo, "src-store.ts"), "export const todos: string[] = [];\n");
	writeFileSync(join(h.repo, "src-routes.ts"), "import { todos } from \"./src-store\";\nexport const add = (t: string) => { todos.push(t); };\n");
	execFileSync("git", ["add", "."], { cwd: h.repo });
	execFileSync("git", ["-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "todo app"], { cwd: h.repo });
}

/** A scripted understanding pass over the todo app: API + Storage domains, one invariant. */
function understandTurn(): ReturnType<typeof planningTurn> {
	return {
		events: [{ type: "message", message: { role: "assistant", text: "System model written.", thinking: "", toolCalls: [] } }],
		effect: ({ spec, prompt }) => {
			const report = prompt.match(/absolute path `([^`]+reviews\/[^`]+)`/)?.[1];
			if (report) {
				mkdirSync(dirname(report), { recursive: true });
				writeFileSync(
					report,
					"# System model\n\n## Domains\n\n- **API** — the HTTP routes (`src-routes.ts`).\n- **Storage** — the in-memory todo list (`src-store.ts`).\n\n## Invariants as built\n\n- **INV-1** — a todo's title is never empty (`src-store.ts:1`).\n",
				);
			}
			writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Model ready." }));
		},
	};
}

/** What the todo app's builder learned while adding toggle: a gotcha, a coupling edge, an invariant fix. */
const LEARN_JSON = JSON.stringify({
	proposals: [
		{
			action: "add_node",
			kind: "gotcha",
			name: "Toggle mutates in place",
			summary: "toggle() edits the array entry, so subscribers see the same object change.",
			source: "src-store.ts:2",
			evidence: "test output: toggle(0) leaves todos.length unchanged; the entry itself flipped",
		},
		{
			action: "add_edge",
			edgeKind: "depends_on",
			from: "domain:api",
			to: "domain:storage",
			evidence: "src-routes.ts:1 imports the store directly",
		},
		{
			action: "update_node",
			kind: "invariant",
			name: "INV-1",
			summary: "Enforced at the route, not the store: empty titles are rejected in add().",
			evidence: "src-routes.ts:3 returns early on an empty title",
		},
		{ action: "add_node", kind: "domain", name: "API", summary: "Already seeded — must be dropped as a duplicate.", source: "x:1", evidence: "duplicate of the seed" },
		{ action: "add_node", kind: "gotcha", name: "No evidence on this one" },
	],
});

function script(learn: string | null = LEARN_JSON): FakeScript {
	return (spec) => {
		if (spec.sessionId.includes("understand-system")) return [understandTurn()];
		if (spec.sessionId.includes("-plan-")) return [planningTurn()];
		if (spec.sessionId.includes("-build-") || spec.sessionId.includes("-cifix-")) {
			const turn = buildingTurn();
			return [
				{
					...turn,
					effect: (ctx) => {
						turn.effect?.(ctx);
						if (learn !== null) writeFileSync(join(ctx.spec.sessionDir, "..", "learn.json"), learn);
					},
				},
			];
		}
		if (spec.sessionId.includes("-test-")) return [testerTurn()];
		return [reviewTurn()];
	};
}

async function toFeedbackGate() {
	const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
	await h.api("PATCH", `/api/projects/${project.id}`, { verifyCommand: "true" });
	await h.api("POST", `/api/projects/${project.id}/understand`);
	await h.daemon.whenIdle();
	const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add toggle to todos", brief: "Clicking a todo flips its done state." })).body;
	await h.api("POST", `/api/cards/${card.id}/enqueue`);
	await h.daemon.whenIdle();
	const detail = (await h.api("GET", `/api/cards/${card.id}`)).body;
	const planGate = detail.gates.find((g: { status: string }) => g.status === "pending");
	await h.api("POST", `/api/cards/${card.id}/gates/${planGate.id}`, { decision: "approve" });
	await h.daemon.whenIdle();
	return { project, card };
}

/** Polls the proposals endpoint until `want` pending proposals exist — the learn step is async by design. */
async function waitForPending(projectId: string, want: number): Promise<{ proposals: Array<{ id: string; status: string; action: string }>; graph: { nodes: number; edges: number } }> {
	for (let i = 0; i < 50; i++) {
		const body = (await h.api("GET", `/api/projects/${projectId}/proposals`)).body;
		if (body.proposals.filter((p: { status: string }) => p.status === "pending").length >= want) return body;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting for ${want} pending proposals`);
}

const graphFile = (projectId: string) => JSON.parse(readFileSync(join(h.home, "projects", projectId, "memory-graph.json"), "utf8"));

describe("the memory graph learns from finished cards", () => {
	it("a card's learn.json lands as pending proposals; a human decision applies or refuses them", async () => {
		h = await bootHarness(script(), ENV);
		seedTodoApp();
		const project = (await h.api("POST", "/api/projects", { repoPath: h.repo })).body;
		await h.api("POST", `/api/projects/${project.id}/understand`);
		await h.daemon.whenIdle();
		// The understanding pass seeded the graph from the promoted model.
		const seeded = graphFile(project.id);
		expect(seeded.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["domain:api", "domain:storage", "invariant:inv-1"]);

		const card = (await h.api("POST", "/api/cards", { projectId: project.id, title: "Add toggle to todos", brief: "Clicking a todo flips its done state." })).body;
		await h.api("POST", `/api/cards/${card.id}/enqueue`);
		await h.daemon.whenIdle();
		const planGate = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.find((g: { status: string }) => g.status === "pending");
		await h.api("POST", `/api/cards/${card.id}/gates/${planGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		const feedbackGate = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.find((g: { status: string }) => g.status === "pending");
		await h.api("POST", `/api/cards/${card.id}/gates/${feedbackGate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card.stage).toBe("done");

		// The learn step filed three proposals; the duplicate add and the evidence-less one were dropped.
		const { proposals, graph } = await waitForPending(project.id, 3);
		expect(graph.nodes).toBe(3);
		expect(graph.edges).toBe(0);
		const byAction = Object.fromEntries(proposals.map((p) => [p.action, p.id]));
		expect(Object.keys(byAction).sort()).toEqual(["add_edge", "add_node", "update_node"]);

		// Accept the gotcha: it enters the graph and the projection re-renders with it.
		const accepted = (await h.api("POST", `/api/projects/${project.id}/proposals/${byAction.add_node}/decide`, { decision: "accept" })).body;
		expect(accepted.applied).toBe(true);
		expect(accepted.proposal.status).toBe("accepted");
		const withGotcha = graphFile(project.id);
		expect(withGotcha.nodes.some((n: { id: string }) => n.id === "gotcha:toggle-mutates-in-place")).toBe(true);
		expect(withGotcha.nodes.find((n: { id: string }) => n.id === "gotcha:toggle-mutates-in-place").provenance.cardId).toBe(card.id);
		const projected = readFileSync(join(h.home, "projects", project.id, "system-model.md"), "utf8");
		expect(projected).toContain("Risks and quirks");
		expect(projected).toContain("Toggle mutates in place");

		// Accept the edge: the blast-radius link lands.
		expect((await h.api("POST", `/api/projects/${project.id}/proposals/${byAction.add_edge}/decide`, { decision: "accept" })).body.applied).toBe(true);
		expect(graphFile(project.id).edges).toHaveLength(1);

		// Accept the invariant update: the wording moves and confidence rises.
		const before = graphFile(project.id).nodes.find((n: { id: string }) => n.id === "invariant:inv-1");
		expect((await h.api("POST", `/api/projects/${project.id}/proposals/${byAction.update_node}/decide`, { decision: "accept" })).body.applied).toBe(true);
		const after = graphFile(project.id).nodes.find((n: { id: string }) => n.id === "invariant:inv-1");
		expect(after.summary).toContain("route, not the store");
		expect(after.provenance.confidence).toBeGreaterThan(before.provenance.confidence);

		// Nothing pending, and the decisions survive a restart.
		expect((await h.api("GET", `/api/projects/${project.id}/proposals`)).body.proposals.filter((p: { status: string }) => p.status === "pending")).toHaveLength(0);
		// A second decision on a decided proposal conflicts instead of silently re-applying.
		const again = await h.api("POST", `/api/projects/${project.id}/proposals/${byAction.add_node}/decide`, { decision: "accept" });
		expect(again.status).toBe(409);
		await h.restart(script());
		const persisted = (await h.api("GET", `/api/projects/${project.id}/proposals`)).body;
		expect(persisted.proposals.filter((p: { status: string }) => p.status === "accepted")).toHaveLength(3);
		expect(persisted.graph.nodes).toBe(4);
		expect(persisted.graph.edges).toBe(1);
	});

	it("a rejected proposal is recorded but never touches the graph", async () => {
		h = await bootHarness(script(), ENV);
		seedTodoApp();
		const { project, card } = await toFeedbackGate();
		const gate = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.find((g: { status: string }) => g.status === "pending");
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();

		const { proposals } = await waitForPending(project.id, 3);
		const gotcha = proposals.find((p) => p.action === "add_node")!;
		const result = (await h.api("POST", `/api/projects/${project.id}/proposals/${gotcha.id}/decide`, { decision: "reject" })).body;
		expect(result.proposal.status).toBe("rejected");
		expect(result.applied).toBe(false);
		expect(graphFile(project.id).nodes.some((n: { id: string }) => n.id === "gotcha:toggle-mutates-in-place")).toBe(false);
	});

	it("an accept the graph refuses stays pending; the human rejects it there", async () => {
		const ghost = JSON.stringify({ proposals: [{ action: "update_node", kind: "invariant", name: "INV-9", summary: "The graph never held this one.", evidence: "a guess, not a finding" }] });
		h = await bootHarness(script(ghost), ENV);
		seedTodoApp();
		const { project, card } = await toFeedbackGate();
		const gate = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.find((g: { status: string }) => g.status === "pending");
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();

		const { proposals } = await waitForPending(project.id, 1);
		const refused = (await h.api("POST", `/api/projects/${project.id}/proposals/${proposals[0]!.id}/decide`, { decision: "accept" })).body;
		expect(refused.applied).toBe(false);
		expect(refused.reason).toContain("not found");
		// Not applied, so not decided: it waits for a real decision instead of half-entering the graph.
		let list = (await h.api("GET", `/api/projects/${project.id}/proposals`)).body;
		expect(list.proposals[0]).toMatchObject({ status: "pending" });
		expect(graphFile(project.id).nodes.some((n: { id: string }) => n.id === "invariant:inv-9")).toBe(false);

		await h.api("POST", `/api/projects/${project.id}/proposals/${proposals[0]!.id}/decide`, { decision: "reject" });
		list = (await h.api("GET", `/api/projects/${project.id}/proposals`)).body;
		expect(list.proposals[0].status).toBe("rejected");
		expect((await h.api("POST", `/api/projects/${project.id}/proposals/${proposals[0]!.id}/decide`, { decision: "reject" })).status).toBe(409);
	});

	it("malformed learn.json never blocks the finish line", async () => {
		h = await bootHarness(script("{ this is not json"), ENV);
		seedTodoApp();
		const { project, card } = await toFeedbackGate();
		const gate = (await h.api("GET", `/api/cards/${card.id}`)).body.gates.find((g: { status: string }) => g.status === "pending");
		await h.api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
		await h.daemon.whenIdle();
		expect((await h.api("GET", `/api/cards/${card.id}`)).body.card.stage).toBe("done");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await h.api("GET", `/api/projects/${project.id}/proposals`)).body.proposals).toHaveLength(0);
	});
});
