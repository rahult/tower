import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BLOB_THRESHOLD, eventId, firstTag, KIND, Ledger, newKeys, type NostrEvent, problemWith, refs, serialize, sign, verifyRecord } from "../src/index.ts";

const ROOT = "a".repeat(40);

describe("nostr events", () => {
	it("serialises with only the escapes NIP-01 allows", () => {
		const event = { pubkey: "ab", created_at: 1, kind: 1, tags: [["t", 'a"b']], content: "x\n<y>& \\" };
		expect(serialize(event)).toBe('[0,"ab",1,1,[["t","a\\"b"]],"x\\n<y>& \\\\"]');
	});

	it("signs, verifies, and notices tampering", () => {
		const keys = newKeys();
		const event = sign({ created_at: 1_763_000_000, kind: KIND.turn, tags: [], content: "hello" }, keys.human_sk);
		expect(event.pubkey).toBe(keys.human_pk);
		expect(problemWith(event)).toBeNull();
		expect(problemWith({ ...event, content: "hello!" })).toMatch(/id does not match/);
		expect(problemWith({ ...event, sig: event.sig.replace(/^../, event.sig.startsWith("00") ? "01" : "00") })).toMatch(/signature|malformed/);
	});

	it("verifies events signed by the Go recorder, and computes the same ids", () => {
		const events = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "fulcrum-events.json"), "utf8")) as NostrEvent[];
		expect(events.length).toBeGreaterThan(3);
		for (const event of events) {
			expect(eventId(event)).toBe(event.id);
			expect(problemWith(event)).toBeNull();
		}
	});

	it("replaces lone surrogates before hashing, so stored text is the text that was signed", () => {
		const event = sign({ created_at: 1, kind: KIND.turn, tags: [], content: "broken \ud800 pair" }, newKeys().scribe_sk);
		expect(event.content).toBe("broken � pair");
		expect(problemWith(JSON.parse(JSON.stringify(event)) as NostrEvent)).toBeNull();
	});
});

describe("ledger", () => {
	it("chains a session's turns and signs a person's words with the person's key", () => {
		const keys = newKeys();
		const ledger = new Ledger(keys, ROOT);
		const prompt = ledger.turn({ session: "s1", role: "prompt", view: "text", text: "Plan the work.", at: 10 });
		const reply = ledger.turn({ session: "s1", role: "agent", view: "text", text: "Planned.", at: 11, cause: prompt.id, agent: "some/model" });
		const steer = ledger.turn({ session: "s1", role: "human", view: "text", text: "Use the existing logger.", at: 12 });
		const other = ledger.turn({ session: "s2", role: "agent", view: "text", text: "Elsewhere.", at: 13 });

		expect(firstTag(prompt, "seq")).toBe("1");
		expect(refs(prompt, "prev")).toEqual([]);
		expect(refs(reply, "prev")).toEqual([prompt.id]);
		expect(refs(reply, "cause")).toEqual([prompt.id]);
		expect(refs(steer, "prev")).toEqual([reply.id]);
		expect(firstTag(other, "seq")).toBe("1");
		expect(firstTag(reply, "r")).toBe(ROOT);
		expect([prompt.pubkey, reply.pubkey, steer.pubkey]).toEqual([keys.scribe_pk, keys.scribe_pk, keys.human_pk]);
		expect(verifyRecord(ledger.events)).toEqual([]);
	});

	it("moves oversized text to a blob and keeps a preview and the hash", () => {
		const ledger = new Ledger(newKeys(), ROOT);
		const text = "é".repeat(BLOB_THRESHOLD);
		const turn = ledger.turn({ session: "s1", role: "tool", view: "tool", text, at: 1 });
		const hash = firstTag(turn, "x") as string;
		expect(ledger.blobs.get(hash)).toBe(text);
		expect(firstTag(turn, "size")).toBe(String(BLOB_THRESHOLD * 2));
		expect(turn.content.length).toBeLessThan(2200);
	});

	it("seals a change that names both ends of every session, its decisions and its direction", () => {
		const keys = newKeys();
		const ledger = new Ledger(keys, ROOT);
		const first = ledger.turn({ session: "s1", role: "prompt", view: "text", text: "Go.", at: 1 });
		const last = ledger.turn({ session: "s1", role: "agent", view: "text", text: "Done.", at: 2, cause: first.id });
		const direction = ledger.direction("Retries for the HTTP client.", 1);
		const decision = ledger.decision({ question: "Approve this plan?", options: ["approve", "reject"], verdict: "redirect", picked: "reject", why: "Cap the retries.", cites: [last.id], at: 3 });
		const input = { commit: "b".repeat(40), summary: "Add retry", at: 4, decisions: [decision.id], direction: direction.id, linesAdded: 7, tool: { name: "tower", version: "0.0.0" } };
		const change = ledger.change(input);

		expect(change.pubkey).toBe(keys.human_pk);
		expect(change.tags).toContainEqual(["transcript", "s1", first.id, last.id]);
		expect(refs(change, "decision")).toEqual([decision.id]);
		expect(refs(change, "direction")).toEqual([direction.id]);
		const body = JSON.parse(change.content);
		expect(body).toMatchObject({ summary: "Add retry", counts: { turns: 2, decisions: 1, lines_added: 7 }, trace: { version: "0.1.0", vcs: { type: "git", revision: "b".repeat(40) }, timestamp: "1970-01-01T00:00:04Z" } });
		expect(JSON.parse(decision.content)).toEqual({ question: "Approve this plan?", options: ["approve", "reject"], verdict: "redirect", picked: "reject", why: "Cap the retries." });
		expect(verifyRecord(ledger.events)).toEqual([]);
		// Sealing the same commit again yields the same event: the id depends only on what was recorded.
		const again = new Ledger(keys, ROOT);
		again.turn({ session: "s1", role: "prompt", view: "text", text: "Go.", at: 1 });
		again.turn({ session: "s1", role: "agent", view: "text", text: "Done.", at: 2, cause: first.id });
		again.direction("Retries for the HTTP client.", 1);
		again.decision({ question: "Approve this plan?", options: ["approve", "reject"], verdict: "redirect", picked: "reject", why: "Cap the retries.", cites: [last.id], at: 3 });
		expect(again.change(input).id).toBe(change.id);
	});
});

describe("verifyRecord", () => {
	const record = () => {
		const keys = newKeys();
		const ledger = new Ledger(keys, ROOT);
		const a = ledger.turn({ session: "s1", role: "prompt", view: "text", text: "one", at: 1 });
		const b = ledger.turn({ session: "s1", role: "agent", view: "text", text: "two", at: 2 });
		const c = ledger.turn({ session: "s1", role: "agent", view: "text", text: "three", at: 3 });
		return { keys, ledger, a, b, c };
	};

	it("notices a missing turn", () => {
		const { a, c } = record();
		expect(verifyRecord([a, c]).join(" ")).toMatch(/expected turn 2, found 3/);
	});

	it("notices a citation of something that is not there", () => {
		const { ledger, b } = record();
		const decision = ledger.decision({ question: "Ship?", verdict: "pick", cites: [b.id], at: 4 });
		expect(verifyRecord(ledger.events.filter((event) => event.id !== b.id)).join(" ")).toContain(`${decision.id.slice(0, 8)} cites ${b.id.slice(0, 8)}`);
	});

	it("notices a recorder key signing a person's words", () => {
		const { keys, ledger } = record();
		const forged = sign({ created_at: 5, kind: KIND.decision, tags: [["verdict", "pick"]], content: "{}" }, keys.scribe_sk);
		expect(verifyRecord([...ledger.events, forged]).join(" ")).toMatch(/speaks for a person but is signed by a recorder key/);
	});
});
