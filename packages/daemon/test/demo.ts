/**
 * UI demo: boots the real daemon on the scripted fake driver (no model calls) and seeds a board with cards in
 * every state. Run: node packages/daemon/test/demo.ts   then open http://127.0.0.1:4720
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE_RESULT_FILE } from "@tower/core";
import { loadConfig } from "../src/config.ts";
import { startDaemon } from "../src/daemon.ts";
import { FakeSessionDriver, type FakeTurn } from "../src/pi/fake-driver.ts";
import { buildingTurn, planningTurn, reviewTurn, simulationTurn, testerTurn } from "./harness.ts";

const root = mkdtempSync(join(tmpdir(), "tower-demo-"));
function repo(name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(path, "README.md"), `# ${name}\n`);
	git("add", ".");
	git("-c", "user.name=tc", "-c", "user.email=tc@local", "commit", "-q", "-m", "init");
	return path;
}

const result = (status: string, summary: string): FakeTurn => ({
	events: [],
	effect: ({ spec }) => writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status, summary })),
});
const busy: FakeTurn = {
	hang: true,
	delayMs: 400,
	events: [
		{ type: "thinking", delta: "The retry wrapper lives in src/http/client.ts. " },
		{ type: "tool_start", id: "t1", name: "read", args: { path: "src/http/client.ts" } },
		{ type: "tool_end", id: "t1", name: "read", isError: false, output: "export async function request(url) { … }" },
		{ type: "text", delta: "I'll add exponential backoff with jitter around the fetch call, " },
		{ type: "text", delta: "capped at five attempts, and keep the signature unchanged." },
		{ type: "tool_start", id: "t2", name: "bash", args: { command: "pnpm test --filter http" } },
	],
};

// The card's title decides how its sessions behave.
const driver = new FakeSessionDriver((spec) => {
	const stage = spec.sessionId.includes("-plan-") ? "plan" : spec.sessionId.includes("-build-") ? "build" : spec.sessionId.includes("-test-") ? "test" : "review";
	// One reviewer finds something blocking, so the feedback gate has something to show.
	if (stage === "review") return [reviewTurn(spec.sessionId.includes("adversarial") ? "fail" : "pass")];
	// The drawer's Invariant simulation flow works on any resting card, scripted like the rest.
	if (spec.sessionId.includes("invariant-simulation")) return [simulationTurn("pass")];
	const title = titles.get(spec.sessionId.slice(1, 9)) ?? "";
	if (title.startsWith("Add retry") && stage === "build") return [busy];
	if (title.startsWith("Migrate") && stage === "plan") {
		return [
			{
				events: [{ type: "message", message: { role: "assistant", text: "Two ORMs are in use here, and the schema change touches both. I need two decisions before I can plan this.", thinking: "", toolCalls: [] } }],
				effect: ({ spec }) =>
					writeFileSync(
						join(spec.sessionDir, "..", STAGE_RESULT_FILE),
						JSON.stringify({
							status: "blocked",
							summary: "Two decisions change the plan.",
							questions: [
								{ question: "Which ORM should the migration target?", options: ["Drizzle (used by the newer services)", "Prisma (used by billing)", "Both, behind a shared migration runner"] },
								{ question: "Can the migration take the ledger table offline?", options: ["No, it must be online", "Yes, a short maintenance window is fine"] },
								{ question: "Anything about the rollout I should know?", options: [] },
							],
						}),
					),
			},
		];
	}
	if (title.startsWith("Dark mode") && stage === "plan") return [busy];
	return [stage === "plan" ? planningTurn() : stage === "build" ? buildingTurn() : testerTurn()];
});
const titles = new Map<string, string>();

const daemon = await startDaemon(loadConfig({ TOWER_HOME: join(root, "home"), TOWER_PORT: "4720", TOWER_MAX_CONCURRENT: "3" }), driver);
const api = async (method: string, path: string, body?: unknown): Promise<any> =>
	(await fetch(`${daemon.url}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();

const seed: Record<string, Array<[title: string, brief: string, advance: "backlog" | "plan" | "approve"]>> = {
	axiom: [
		["Add retry with backoff to the HTTP client", "Wrap request() so transient 5xx and network errors are retried.", "approve"],
		["Expose closure predicates over the CLI", "Add `axiom closure <predicate>` with JSON output.", "plan"],
		["Migrate persistence to the new schema", "Move facts and rules tables to schema v4.", "plan"],
		["Document the rule engine", "A README section with two worked examples.", "backlog"],
	],
	remembero: [
		["Ship only necessary files in the npm package", "Tighten the files allowlist; ignore OS junk.", "approve"],
		["Dark mode for the treemap view", "Follow the OS setting; keep contrast AA.", "plan"],
		["Heatmap legend", "Show the scale and units beside the heatmap.", "backlog"],
	],
	freeup: [["Add a dry-run flag", "Print what would be deleted without deleting.", "backlog"]],
};

for (const [name, cards] of Object.entries(seed)) {
	const project = await api("POST", "/api/projects", { repoPath: repo(name) });
	if (name !== "freeup") await api("PATCH", `/api/projects/${project.id}`, { verifyCommand: name === "axiom" ? "true" : "", concurrencyLimit: 2 });
	for (const [title, brief, advance] of cards) {
		const card = await api("POST", "/api/cards", { projectId: project.id, title, brief });
		titles.set(card.id, title);
		if (advance === "backlog") continue;
		await api("POST", `/api/cards/${card.id}/enqueue`);
		if (advance !== "approve") continue;
		// Wait for the plan to reach its gate, then approve it.
		for (let i = 0; i < 200; i++) {
			const detail = await api("GET", `/api/cards/${card.id}`);
			const gate = detail.gates.find((g: { status: string }) => g.status === "pending");
			if (gate) {
				await api("POST", `/api/cards/${card.id}/gates/${gate.id}`, { decision: "approve" });
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}
console.log(`demo board on ${daemon.url} (data in ${root}). Ctrl+C to stop.`);
process.on("SIGINT", () => void daemon.close().finally(() => process.exit(0)));
