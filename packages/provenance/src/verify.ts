import { firstTag, type NostrEvent, problemWith, refs } from "./nostr.ts";
import { KIND } from "./record.ts";

const speaksForAPerson = (event: NostrEvent): boolean => {
	if (event.kind !== KIND.turn) return true;
	const role = firstTag(event, "role");
	return role === "human" || role === "permission";
};

/**
 * Checks a set of Change-record events: every signature, every session's hash chain, every citation, and that
 * no recorder key signed something only a person can say. Returns the problems found; empty means sound.
 */
export function verifyRecord(events: NostrEvent[]): string[] {
	const problems: string[] = [];
	const byId = new Map(events.map((event) => [event.id, event]));
	const scribes = new Set(events.filter((event) => !speaksForAPerson(event)).map((event) => event.pubkey));
	const sessions = new Map<string, NostrEvent[]>();

	for (const event of events) {
		const problem = problemWith(event);
		if (problem) problems.push(problem);
		if (speaksForAPerson(event) && scribes.has(event.pubkey)) problems.push(`${event.id.slice(0, 8)} speaks for a person but is signed by a recorder key`);
		if (event.kind === KIND.turn) {
			const session = firstTag(event, "session") ?? "";
			sessions.set(session, [...(sessions.get(session) ?? []), event]);
		}
		if (event.kind === KIND.decision || event.kind === KIND.change) {
			for (const tag of event.tags) {
				if (tag[0] === "e" && tag[1] && !byId.has(tag[1])) problems.push(`${event.id.slice(0, 8)} cites ${tag[1].slice(0, 8)} (${tag[3] ?? "unmarked"}), which is missing`);
			}
		}
	}

	for (const [session, turns] of sessions) {
		turns.sort((a, b) => Number(firstTag(a, "seq")) - Number(firstTag(b, "seq")));
		for (const [index, turn] of turns.entries()) {
			const seq = Number(firstTag(turn, "seq"));
			if (seq !== index + 1) {
				problems.push(`session ${session}: expected turn ${index + 1}, found ${seq} (a turn is missing or duplicated)`);
				break;
			}
			const prev = refs(turn, "prev");
			const sound = index === 0 ? prev.length === 0 : prev.length === 1 && prev[0] === turns[index - 1]?.id;
			if (!sound) {
				problems.push(`session ${session}: turn ${seq} does not chain to turn ${seq - 1}`);
				break;
			}
		}
	}
	return problems;
}
