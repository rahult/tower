import { createHash } from "node:crypto";
import { generateKey, type NostrEvent, sign, type Tag } from "./nostr.ts";

/**
 * The Change record: what was decided while a change was made, signed and attached to the change.
 *
 * Five event kinds, all regular (never replaceable), so an event's id is the hash of its content and a relay
 * cannot swap one version for another. The format is shared with the standalone `fulcrum` recorder
 * (github.com/rahult/fulcrum, docs/SPEC.md): either tool can read what the other wrote.
 */
export const KIND = {
	/** One transcript turn, hash-chained to the turn before it in its session. */
	turn: 4680,
	/** A person's verdict, citing the turns it came from. */
	decision: 4681,
	/** One version of the brief the work was serving. */
	direction: 4682,
	/** A sealed change: commit, transcript spans, decisions, direction and attribution. */
	change: 4683,
	/** A person's check of something an agent or recorder asserted. */
	audit: 4684,
} as const;

export const KINDS: number[] = Object.values(KIND);

/**
 * Who said a turn. `human` and `permission` are a person's own words and are signed with the person's key;
 * everything else is the recorder attesting to what it saw, signed with the scribe key.
 */
export type Role = "human" | "permission" | "prompt" | "agent" | "thought" | "tool" | "edit" | "system";

const HUMAN_ROLES: ReadonlySet<Role> = new Set(["human", "permission"]);

/** Same JSON shape as fulcrum's keys.json, so one identity can serve both tools. */
export interface Keys {
	human_sk: string;
	human_pk: string;
	scribe_sk: string;
	scribe_pk: string;
}

export function newKeys(): Keys {
	const human = generateKey();
	const scribe = generateKey();
	return { human_sk: human.secretKey, human_pk: human.publicKey, scribe_sk: scribe.secretKey, scribe_pk: scribe.publicKey };
}

/** Turn text above this many UTF-8 bytes moves to a content-addressed blob; the event keeps a preview and the hash. */
export const BLOB_THRESHOLD = 48 * 1024;

export interface TurnInput {
	session: string;
	role: Role;
	/** Renderer hint for a UI: text, plan, diff, verdict, tool, question, note, raw. */
	view: string;
	text: string;
	/** Unix seconds. */
	at: number;
	agent?: string;
	/** Id of the turn this one answers: the prompt or steer that caused it. */
	cause?: string;
	extra?: Tag[];
}

export interface DecisionInput {
	question: string;
	options?: string[];
	verdict: "pick" | "kill" | "redirect";
	picked?: string;
	why?: string;
	cites: string[];
	at: number;
	view?: string;
	extra?: Tag[];
}

export interface ChangeInput {
	commit: string;
	summary: string;
	at: number;
	decisions: string[];
	direction?: string;
	linesAdded?: number;
	tool: { name: string; version: string };
	extra?: Tag[];
}

/** Builds and signs the events of one repository, keeping each session's hash chain. */
export class Ledger {
	readonly events: NostrEvent[] = [];
	/** sha256 hex → full text, for turns too large to carry inline. */
	readonly blobs = new Map<string, string>();
	private readonly keys: Keys;
	private readonly root: string;
	private readonly chains = new Map<string, { seq: number; first: string; last: string }>();

	/** `root` is the repository's earliest commit: the id NIP-34 uses to recognise a repository across clones. */
	constructor(keys: Keys, root: string) {
		this.keys = keys;
		this.root = root;
	}

	private emit(kind: number, content: string, tags: Tag[], at: number, human: boolean): NostrEvent {
		const event = sign({ created_at: at, kind, tags: [["r", this.root], ...tags], content }, human ? this.keys.human_sk : this.keys.scribe_sk);
		this.events.push(event);
		return event;
	}

	turn(input: TurnInput): NostrEvent {
		const chain = this.chains.get(input.session);
		const tags: Tag[] = [
			["session", input.session],
			["seq", String((chain?.seq ?? 0) + 1)],
			["role", input.role],
			["view", input.view],
		];
		if (input.agent) tags.push(["agent", input.agent]);
		if (chain) tags.push(["e", chain.last, "", "prev"]);
		if (input.cause) tags.push(["e", input.cause, "", "cause"]);
		tags.push(...(input.extra ?? []));
		let content = input.text.toWellFormed();
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > BLOB_THRESHOLD) {
			const hash = createHash("sha256").update(content, "utf8").digest("hex");
			this.blobs.set(hash, content);
			tags.push(["x", hash], ["size", String(bytes)]);
			content = `${content.slice(0, 2048).toWellFormed()}\n[truncated: full text in blob ${hash.slice(0, 12)}]`;
		}
		const event = this.emit(KIND.turn, content, tags, input.at, HUMAN_ROLES.has(input.role));
		this.chains.set(input.session, { seq: (chain?.seq ?? 0) + 1, first: chain?.first ?? event.id, last: event.id });
		return event;
	}

	decision(input: DecisionInput): NostrEvent {
		// Key order matches fulcrum's Decision struct, so the two tools write byte-identical content.
		const body: Record<string, unknown> = { question: input.question };
		if (input.options?.length) body.options = input.options;
		body.verdict = input.verdict;
		if (input.picked) body.picked = input.picked;
		if (input.why) body.why = input.why;
		const tags: Tag[] = [["verdict", input.verdict], ["view", input.view ?? "options"], ...input.cites.map((id): Tag => ["e", id, "", "cites"]), ...(input.extra ?? [])];
		return this.emit(KIND.decision, JSON.stringify(body), tags, input.at, true);
	}

	direction(text: string, at: number, extra: Tag[] = []): NostrEvent {
		return this.emit(KIND.direction, text, extra, at, true);
	}

	/** Seals everything recorded so far to a commit. The turns are hash-chained, so naming both ends of a session fixes every turn between. */
	change(input: ChangeInput): NostrEvent {
		const tags: Tag[] = [["commit", input.commit]];
		let turns = 0;
		for (const [session, chain] of this.chains) {
			tags.push(["transcript", session, chain.first, chain.last], ["e", chain.last, "", "transcript"]);
			turns += chain.seq;
		}
		for (const id of input.decisions) tags.push(["e", id, "", "decision"]);
		if (input.direction) tags.push(["e", input.direction, "", "direction"]);
		tags.push(...(input.extra ?? []), ["view", "change"]);
		// A stable id for the trace, so sealing the same commit twice yields the same event.
		const digest = createHash("sha256").update(`${this.root}:${input.commit}`).digest("hex");
		const traceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
		const body = {
			summary: input.summary,
			counts: { turns, decisions: input.decisions.length, lines_added: input.linesAdded ?? 0, lines_matched: 0 },
			// An Agent Trace v0.1 record (agent-trace.dev). `files` stays empty until line attribution is computed.
			trace: { version: "0.1.0", id: traceId, timestamp: new Date(input.at * 1000).toISOString().replace(".000Z", "Z"), vcs: { type: "git", revision: input.commit }, tool: input.tool, files: [] },
		};
		return this.emit(KIND.change, JSON.stringify(body), tags, input.at, true);
	}
}
