import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { Card, Project } from "@tower/core";
import { type Keys, Ledger, newKeys, type NostrEvent, publish, type PublishResult, type Tag, verifyRecord } from "@tower/provenance";
import { type Config, paths } from "./config.ts";
import { loadAnnotations } from "./annotations.ts";
import type { Db } from "./db/open.ts";
import { listRunEvents } from "./db/repo-events.ts";
import { listGatesForCard } from "./db/repo-gates.ts";
import { listRunsForCard } from "./db/repo-runs.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout.trim();

/** A problem the HTTP layer reports as a conflict: the card is not in a state that can be sealed. */
export class ProvenanceError extends Error {}

export interface ChangeExport {
	/** Id of the Change event. */
	changeId: string;
	commit: string;
	/** Where the events were written, one JSON event per line. */
	file: string;
	counts: { events: number; turns: number; decisions: number; humanTurns: number };
	/** Present when a relay was asked for: how many events it accepted and refused. */
	published?: { relay: string; accepted: number; rejected: PublishResult[]; error?: string };
}

const VERSION = "0.1.0";
const seconds = (ms: number): number => Math.floor(ms / 1000);

/** The signing keys, created on first use. Same shape as fulcrum's keys.json: copy one over the other to share an identity. */
export function loadKeys(config: Config): Keys {
	const file = join(config.home, "keys.json");
	if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Keys;
	const keys = newKeys();
	mkdirSync(config.home, { recursive: true });
	writeFileSync(file, `${JSON.stringify(keys, null, "\t")}\n`, { mode: 0o600 });
	return keys;
}

const GATE_QUESTION: Record<string, string> = {
	plan_approval: "Approve this plan?",
	feedback: "Approve this work?",
	budget: "Keep going past the budget?",
};

/** pi's file-writing tools, and where each keeps the text it wrote. */
function writtenText(name: string, args: unknown): { path: string; text: string } | null {
	if (typeof args !== "object" || args === null) return null;
	const a = args as Record<string, unknown>;
	const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : null;
	if (!path) return null;
	if (name === "write" && typeof a.content === "string") return { path, text: a.content };
	if (name === "edit") {
		if (typeof a.newText === "string") return { path, text: a.newText };
		if (Array.isArray(a.edits)) {
			const parts = a.edits.map((edit) => (typeof edit === "object" && edit !== null ? (edit as Record<string, unknown>).newText : null)).filter((text) => typeof text === "string");
			if (parts.length > 0) return { path, text: parts.join("\n") };
		}
	}
	return null;
}

/**
 * Seals a card into a Change record: every run's transcript as hash-chained turns, every gate verdict and steer
 * as a person's signed words, the brief it served, and the commit it produced.
 *
 * What is recorded is what Tower persisted. Streaming deltas are not persisted, so text arrives as whole messages.
 * The answers to an agent's questions reach the agent inside a prompt Tower writes, so they are recorded as a
 * prompt turn, signed by the recorder rather than the person. Line-level attribution is not computed here yet:
 * the writes an agent made are recorded as `edit` turns so that it can be.
 */
export async function exportCardChange(deps: { config: Config; db: Db }, card: Card, project: Project, options: { relay?: string } = {}): Promise<ChangeExport> {
	const { config, db } = deps;
	if (!card.branchName) throw new ProvenanceError("This card has no branch yet: there is no change to seal");
	let commit: string;
	let root: string;
	try {
		commit = await git(project.repoPath, "rev-parse", "--verify", `${card.branchName}^{commit}`);
		root = (await git(project.repoPath, "rev-list", "--max-parents=0", commit)).split("\n").at(-1) as string;
	} catch {
		throw new ProvenanceError(`The branch ${card.branchName} is gone, so this card's change cannot be sealed`);
	}

	const ledger = new Ledger(loadKeys(config), root);
	const cardTag: Tag = ["card", card.id];
	/** Every agent or prompt turn with the moment it happened, so a verdict can cite what it was looking at. */
	const citable: Array<{ id: string; ts: number }> = [];
	let turns = 0;
	let humanTurns = 0;
	let latest = card.createdAt;

	const direction = ledger.direction(card.brief.trim() === "" ? `# ${card.title}` : `# ${card.title}\n\n${card.brief.trim()}`, seconds(card.createdAt), [cardTag]);

	for (const run of listRunsForCard(db, card.id).toSorted((a, b) => a.startedAt - b.startedAt)) {
		const session = `tower:${run.id}`;
		const extra: Tag[] = [cardTag, ["stage", run.stage], ["run-kind", run.kind]];
		let cause: string | undefined;
		let lastSaid = "";
		const endedTools = new Set<string>();
		const add = (role: Parameters<Ledger["turn"]>[0]["role"], view: string, text: string, ts: number, more: Tag[] = []): NostrEvent => {
			const event = ledger.turn({ session, role, view, text, at: seconds(ts), agent: run.model, ...(role === "human" || role === "prompt" || !cause ? {} : { cause }), extra: [...extra, ...more] });
			turns += 1;
			latest = Math.max(latest, ts);
			return event;
		};
		for (const item of listRunEvents(db, run.id)) {
			const payload = (item.payload ?? {}) as Record<string, unknown>;
			switch (item.type) {
				case "settled":
				case "queue":
					break; // bookkeeping, not something anyone said
				case "prompt": {
					lastSaid = String(payload.text ?? "");
					const event = add("prompt", "text", lastSaid, item.ts);
					cause = event.id;
					citable.push({ id: event.id, ts: item.ts });
					break;
				}
				case "steer": {
					// A person redirecting the work mid-run: their words, their key.
					lastSaid = String(payload.text ?? "");
					cause = add("human", "text", lastSaid, item.ts).id;
					humanTurns += 1;
					break;
				}
				case "message": {
					const message = (payload.message ?? {}) as { role?: string; text?: string; thinking?: string; error?: string; toolCallId?: string; toolName?: string; isError?: boolean };
					if (message.role === "user") {
						// pi echoes what it was sent; the prompt or steer is already on the record.
						if ((message.text ?? "") !== lastSaid && message.text) cause = add("prompt", "text", message.text, item.ts).id;
					} else if (message.role === "assistant") {
						if (message.thinking) add("thought", "text", message.thinking, item.ts);
						if (message.error) add("agent", "error", message.error, item.ts);
						if (message.text) citable.push({ id: add("agent", "text", message.text, item.ts).id, ts: item.ts });
					} else if (message.role === "toolResult" && !endedTools.has(message.toolCallId ?? "")) {
						add("tool", "tool", message.text ?? "", item.ts, [["tool", message.toolCallId ?? ""], ["tool-name", message.toolName ?? ""], ["status", message.isError ? "failed" : "completed"]]);
					}
					break;
				}
				case "tool_start": {
					const name = String(payload.name ?? "");
					add("tool", "tool", `${name} ${JSON.stringify(payload.args ?? {})}`, item.ts, [["tool", String(payload.id ?? "")], ["tool-name", name], ["status", "pending"]]);
					const written = writtenText(name, payload.args);
					if (written) {
						const inWorktree = card.worktreePath && isAbsolute(written.path) ? relative(card.worktreePath, written.path) : written.path;
						add("edit", "diff", written.text, item.ts, [["path", inWorktree.startsWith("..") ? written.path : inWorktree]]);
					}
					break;
				}
				case "tool_end": {
					endedTools.add(String(payload.id ?? ""));
					add("tool", "tool", String(payload.output ?? ""), item.ts, [["tool", String(payload.id ?? "")], ["tool-name", String(payload.name ?? "")], ["status", payload.isError ? "failed" : "completed"]]);
					break;
				}
				case "ui_request":
					add("agent", "question", JSON.stringify({ method: payload.method, ...((payload.payload as object) ?? {}) }), item.ts, [["ui", String(payload.id ?? "")]]);
					break;
				case "ui_resolved":
					if (payload.outcome === "answered") {
						add("permission", "verdict", JSON.stringify({ request: String(payload.id ?? ""), outcome: "answered" }), item.ts, [["ui", String(payload.id ?? "")]]);
						humanTurns += 1;
					} else add("system", "raw", JSON.stringify({ type: item.type, ...payload }), item.ts);
					break;
				default:
					// Anything Tower noted that has no closer role: verify output, lifecycle notes. Kept so the transcript is whole.
					add("system", "raw", JSON.stringify({ type: item.type, ...payload }), item.ts);
			}
		}
	}

	// Margin notes are a person's judgement pinned to a passage.
	for (const note of loadAnnotations(paths.cardDir(config, card.id)).toSorted((a, b) => a.createdAt - b.createdAt)) {
		ledger.turn({ session: `tower:${card.id}:notes`, role: "human", view: "note", text: JSON.stringify({ artifact: note.artifact, quote: note.quote, note: note.note, resolved: note.resolved }), at: seconds(note.createdAt), extra: [cardTag, ["note", note.id]] });
		turns += 1;
		humanTurns += 1;
		latest = Math.max(latest, note.createdAt);
	}

	// Each decided gate is a verdict, citing the last thing the agent had said when the person decided.
	const decisions: string[] = [];
	for (const gate of listGatesForCard(db, card.id)) {
		if (gate.status === "pending" || gate.decidedAt === null) continue;
		const decidedAt = gate.decidedAt;
		const seen = citable.findLast((turn) => turn.ts <= decidedAt);
		const approved = gate.status === "approved";
		const decision = ledger.decision({
			question: GATE_QUESTION[gate.kind] ?? `Pass the ${gate.kind} gate?`,
			options: ["approve", "reject"],
			verdict: approved ? "pick" : "redirect",
			picked: approved ? "approve" : "reject",
			...(gate.feedback ? { why: gate.feedback } : {}),
			cites: seen ? [seen.id] : [],
			at: seconds(decidedAt),
			view: "gate",
			extra: [cardTag, ["gate", gate.kind]],
		});
		decisions.push(decision.id);
		latest = Math.max(latest, decidedAt);
	}

	let linesAdded = 0;
	if (card.baseCommit) {
		try {
			for (const line of (await git(project.repoPath, "diff", "--numstat", card.baseCommit, commit)).split("\n")) linesAdded += Number(line.split("\t")[0]) || 0;
		} catch {
			// The base is unreachable (a rewritten history); the count is a courtesy, the record stands without it.
		}
	}

	const extra: Tag[] = [cardTag, ["branch", card.branchName], ["attribution", "none"]];
	if (card.baseCommit) extra.push(["base", card.baseCommit]);
	if (card.prUrl) extra.push(["pr", card.prUrl]);
	const change = ledger.change({ commit, summary: card.title, at: seconds(latest), decisions, direction: direction.id, linesAdded, tool: { name: "tower", version: VERSION }, extra });

	const problems = verifyRecord(ledger.events);
	if (problems.length > 0) throw new Error(`The change record for card ${card.id} does not verify: ${problems[0]}`);

	const dir = join(paths.cardDir(config, card.id), "change");
	mkdirSync(join(dir, "blobs"), { recursive: true });
	const file = join(dir, "events.jsonl");
	writeFileSync(file, `${ledger.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	for (const [hash, text] of ledger.blobs) writeFileSync(join(dir, "blobs", hash), text);

	const result: ChangeExport = { changeId: change.id, commit, file, counts: { events: ledger.events.length, turns, decisions: decisions.length, humanTurns } };
	if (options.relay) {
		// The record is already on disk; a relay that cannot be reached is reported, not thrown.
		try {
			const sent = await publish(options.relay, ledger.events);
			result.published = { relay: options.relay, accepted: sent.filter((r) => r.ok).length, rejected: sent.filter((r) => !r.ok) };
		} catch (error) {
			result.published = { relay: options.relay, accepted: 0, rejected: [], error: error instanceof Error ? error.message : String(error) };
		}
	}
	return result;
}
