/**
 * UI demo: boots the real daemon on the scripted fake driver (no model calls) and seeds a board with cards in
 * every state. Run: node packages/daemon/test/demo.ts   then open http://127.0.0.1:4720
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE_RESULT_FILE } from "@tower/core";
import { loadConfig } from "../src/config.ts";
import { startDaemon } from "../src/daemon.ts";
import { FakeSessionDriver, type FakeTurn } from "../src/pi/fake-driver.ts";
import { buildingTurn, crewPlanningTurn, integratorTurn, planningTurn, reviewTurn, scoutTurn, simulationTurn, streamBuilderTurn, testerTurn } from "./harness.ts";

const root = mkdtempSync(join(tmpdir(), "tower-demo-"));

// The feedback loop is part of the demo, so it needs a GitHub that cannot be broken: a stub gh whose
// "issues" live in a local file. Feedback filed from the board lands there; intake reads it back as cards.
const ghBin = join(root, "gh-bin");
mkdirSync(ghBin, { recursive: true });
const ghState = join(root, "github.json");
writeFileSync(
	ghState,
	JSON.stringify({
		issues: [
			{ number: 12, title: "Keyboard focus escapes the inspector", body: "Tabbing past the last tab bar button throws focus back to the page.", author: "board", url: "https://github.com/rahult/tower/issues/12" },
			{ number: 13, title: "Show the branch on the mini card", body: "I want to see which branch a running card is on without opening it.", author: "board", url: "https://github.com/rahult/tower/issues/13" },
		],
		nextNumber: 41,
		pr: null,
	}),
);
writeFileSync(
	join(ghBin, "gh"),
	`#!/usr/bin/env node
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "label" && args[1] === "create") { console.log("ok"); }
else if (args[0] === "issue" && args[1] === "list") { console.log(JSON.stringify(state.issues.map((i) => ({ ...i, author: { login: i.author } })))); }
else if (args[0] === "issue" && args[1] === "create") {
	const body = fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8");
	const issue = { number: state.nextNumber++, title: args[args.indexOf("--title") + 1], body, author: "board", url: \`https://github.com/rahult/tower/issues/\${state.nextNumber - 1}\` };
	state.issues.push(issue);
	fs.writeFileSync(${JSON.stringify(ghState)}, JSON.stringify(state));
	console.log(issue.url);
} else if (args[0] === "issue" && args[1] === "comment") { console.log("commented"); }
else if (args[0] === "issue" && args[1] === "close") { console.log("closed"); }
else if (args[0] === "pr" && args[1] === "view") { if (!state.pr) { process.exit(1); } console.log(JSON.stringify(state.pr)); }
else if (args[0] === "pr" && args[1] === "create") {
	const url = "https://github.com/rahult/tower/pull/77";
	state.pr = { url, state: "OPEN", headRefOid: "sha-demo", statusCheckRollup: [] };
	fs.writeFileSync(${JSON.stringify(ghState)}, JSON.stringify(state));
	console.log(url);
} else { console.error("unexpected gh call: " + args.join(" ")); process.exit(2); }
`,
);
chmodSync(join(ghBin, "gh"), 0o755);
process.env.PATH = `${ghBin}:${process.env.PATH}`;

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

/** A scripted deep-research step: writes its piece where the prompt points. The brief is what the planner would read. */
function researchTurn(label: string): FakeTurn {
	const brief = [
		`# ${label}`,
		"",
		"## TL;DR",
		"",
		"- Three realistic options: CRDT via Yjs, event-sourced sync via a log, and plain last-write-wins with tombstones.",
		"- The notes app is single-user-mostly, so the merge conflicts that make CRDTs worth it are rare — but offline capture is a daily event.",
		"- Recommendation: event-sourced sync behind the storage interface; revisit a CRDT when sharing lands.",
		"",
		"## Sources",
		"",
		"- https://github.com/yjs/yjs — CRDT library, active releases.",
		"- https://www.inkandswitch.com/peritext/ — local-first editing research.",
	].join("\n");
	return {
		events: [{ type: "message", message: { role: "assistant", text: `${label} written.`, thinking: "", toolCalls: [] } }],
		effect: ({ spec, prompt }) => {
			const report = prompt.match(/absolute path `([^`]+reviews\/[^`]+)`/)?.[1];
			if (report) writeFileSync(report, brief);
			writeFileSync(join(spec.sessionDir, "..", STAGE_RESULT_FILE), JSON.stringify({ status: "pass", summary: "Brief ready." }));
		},
	};
}

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
	// The ask box's intent reader: the fake agent cannot read the typed line, so it files a canned
	// verdict on the tower lane — enough to show the loop from keystroke to card.
	if (spec.sessionId.includes("assist"))
		return [
			{
				events: [
					{
						type: "message",
						message: {
							role: "assistant",
							text: JSON.stringify({ action: "add_card", project: "tower", title: "Card filed from the ask box", brief: "The demo's fake agent scripts this verdict; a real Tower reads the line." }),
							thinking: "",
							toolCalls: [],
						},
					},
				],
			},
		];
	// The crew card's members first: their ids carry no stage token, so they must not fall through to reviews.
	if (spec.sessionId.includes("-scout-")) return [scoutTurn()];
	if (spec.sessionId.includes("-ws-")) return [streamBuilderTurn()];
	if (spec.sessionId.includes("-integrator")) return [integratorTurn()];
	// The deep-research flow's two steps, so exploring-before-committing is scriptable on the demo board.
	if (spec.sessionId.includes("deep-research-survey")) return [researchTurn("Survey notes")];
	if (spec.sessionId.includes("deep-research-synthesize")) return [researchTurn("Research brief")];
	const stage = spec.sessionId.includes("-plan-") ? "plan" : spec.sessionId.includes("-build-") ? "build" : spec.sessionId.includes("-test-") ? "test" : "review";
	// One reviewer finds something blocking, so the feedback gate has something to show.
	if (stage === "review") return [reviewTurn(spec.sessionId.includes("adversarial") ? "fail" : "pass")];
	// The drawer's Invariant simulation flow works on any resting card, scripted like the rest.
	if (spec.sessionId.includes("invariant-simulation")) return [simulationTurn("pass")];
	const title = titles.get(spec.sessionId.slice(1, 9)) ?? "";
	if (title.startsWith("Add retry") && stage === "build") return [busy];
	if (title.startsWith("Split") && stage === "plan") return [crewPlanningTurn()];
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

// The person's own flow, in <home>/flows where a real one lives: a deterministic, informational gate
// that records the shape of every build before it is tested. Demonstrates "design your own agent".
mkdirSync(join(root, "home", "flows"), { recursive: true });
writeFileSync(
	join(root, "home", "flows", "change-audit.flow.json"),
	JSON.stringify(
		{
			name: "change-audit",
			title: "Change audit",
			description: "Records the shape of every build before it is tested — informational, it never blocks.",
			when: ["after-build"],
			steps: [{ name: "shape", run: "git log -1 --stat --oneline | tail -4", expect: "note", timeoutSec: 30 }],
		},
		null,
		"\t",
	) + "\n",
);


const daemon = await startDaemon(
	loadConfig({
		TOWER_HOME: join(root, "home"),
		TOWER_PORT: process.env.TOWER_PORT ?? "4720",
		TOWER_MAX_CONCURRENT: "3",
		TOWER_FEEDBACK_REPO: "rahult/tower",
		TOWER_ISSUES_POLL_MS: "4000",
	}),
	driver);
const api = async (method: string, path: string, body?: unknown): Promise<any> =>
	(await fetch(`${daemon.url}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();

const seed: Record<string, Array<[title: string, brief: string, advance: "backlog" | "plan" | "approve"]>> = {
	axiom: [
		["Add retry with backoff to the HTTP client", "Wrap request() so transient 5xx and network errors are retried.", "approve"],
		["Split the config loader into modules", "One module per source: env, file, flags. The plan splits it into parallel streams.", "approve"],
		["Expose closure predicates over the CLI", "Add `axiom closure <predicate>` with JSON output.", "plan"],
		["Migrate persistence to the new schema", "Move facts and rules tables to schema v4.", "plan"],
		["Document the rule engine", "A README section with two worked examples.", "backlog"],
	],
	remembero: [
		["Ship only necessary files in the npm package", "Tighten the files allowlist; ignore OS junk.", "approve"],
		["Dark mode for the treemap view", "Follow the OS setting; keep contrast AA.", "plan"],
		["Heatmap legend", "Show the scale and units beside the heatmap.", "backlog"],
		["Research local-first sync for the notes app", "Offline capture and merge: a CRDT, an event log, or last-write-wins? Explore before planning.", "backlog"],
	],
	freeup: [["Add a dry-run flag", "Print what would be deleted without deleting.", "backlog"]],
};

for (const [name, cards] of Object.entries(seed)) {
	const project = await api("POST", "/api/projects", { repoPath: repo(name) });
	if (name !== "freeup")
		await api("PATCH", `/api/projects/${project.id}`, {
			verifyCommand: name === "axiom" ? "true" : "",
			concurrencyLimit: 2,
			// Hands-on commands, so the Run tab has something to show on the demo board.
			...(name === "axiom" ? { testCommand: 'echo "12 passed, 0 failed"; echo "covering 34 invariants"' } : {}),
			...(name === "remembero" ? { previewCommand: "python3 -m http.server 8899", previewUrl: "http://localhost:8899" } : {}),
		});
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
// Tower itself, so the feedback loop has a lane: the checkout's origin parses as the feedback repo,
// and intake lands the stub GitHub's open issues here as inert backlog cards within seconds.
const towerOrigin = join(root, "github.com", "rahult", "tower.git");
mkdirSync(towerOrigin, { recursive: true });
execFileSync("git", ["init", "-q", "--bare", towerOrigin]);
const towerPath = repo("tower");
execFileSync("git", ["remote", "add", "origin", towerOrigin], { cwd: towerPath });
await api("POST", "/api/projects", { repoPath: towerPath });

// The research card explores before any work starts: the deep-research flow runs on the backlog card,
// straight in the project checkout, and the brief lands in the card's files.
{
	const board = await api("GET", "/api/board");
	const research = board.cards.find((card: { title: string }) => card.title.startsWith("Research local-first"));
	if (research) await api("POST", `/api/cards/${research.id}/adhoc`, { flow: "deep-research" });
}

console.log(`demo board on ${daemon.url} (data in ${root}). Ctrl+C to stop.`);
process.on("SIGINT", () => void daemon.close().finally(() => process.exit(0)));
