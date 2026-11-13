import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

/** One NIP-01 tag: a name followed by its values. */
export type Tag = string[];

export interface UnsignedEvent {
	created_at: number;
	kind: number;
	tags: Tag[];
	content: string;
}

export interface NostrEvent extends UnsignedEvent {
	id: string;
	pubkey: string;
	sig: string;
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

/** A JSON string with exactly the escapes NIP-01 allows; everything else is verbatim, which JSON.stringify does not promise. */
function quote(text: string): string {
	let out = '"';
	for (const char of text) {
		if (char === "\n") out += "\\n";
		else if (char === '"') out += '\\"';
		else if (char === "\\") out += "\\\\";
		else if (char === "\r") out += "\\r";
		else if (char === "\t") out += "\\t";
		else if (char === "\b") out += "\\b";
		else if (char === "\f") out += "\\f";
		else out += char;
	}
	return `${out}"`;
}

/** The NIP-01 id preimage: [0,pubkey,created_at,kind,tags,content]. */
export function serialize(event: UnsignedEvent & { pubkey: string }): string {
	const tags = event.tags.map((tag) => `[${tag.map(quote).join(",")}]`).join(",");
	return `[0,${quote(event.pubkey)},${event.created_at},${event.kind},[${tags}],${quote(event.content)}]`;
}

export function eventId(event: UnsignedEvent & { pubkey: string }): string {
	return createHash("sha256").update(serialize(event), "utf8").digest("hex");
}

export function publicKey(secretKey: string): string {
	return toHex(schnorr.getPublicKey(fromHex(secretKey)));
}

export function generateKey(): { secretKey: string; publicKey: string } {
	const { secretKey, publicKey: pub } = schnorr.keygen();
	return { secretKey: toHex(secretKey), publicKey: toHex(pub) };
}

/** Signs an event. Lone surrogates are replaced first, so the stored text is exactly the text that was hashed. */
export function sign(event: UnsignedEvent, secretKey: string): NostrEvent {
	const body = { ...event, content: event.content.toWellFormed(), tags: event.tags.map((tag) => tag.map((value) => value.toWellFormed())), pubkey: publicKey(secretKey) };
	const id = eventId(body);
	return { id, pubkey: body.pubkey, created_at: body.created_at, kind: body.kind, tags: body.tags, content: body.content, sig: toHex(schnorr.sign(fromHex(id), fromHex(secretKey))) };
}

/** Why an event is not valid, or null when its id matches its content and its signature matches its id. */
export function problemWith(event: NostrEvent): string | null {
	if (eventId(event) !== event.id) return `id does not match content on ${event.id.slice(0, 8)}`;
	try {
		if (!schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))) return `signature does not verify on ${event.id.slice(0, 8)}`;
	} catch {
		return `malformed key or signature on ${event.id.slice(0, 8)}`;
	}
	return null;
}

/** First value of the first tag with this name. */
export const firstTag = (event: UnsignedEvent, name: string): string | undefined => event.tags.find((tag) => tag[0] === name)?.[1];

/** Ids of the "e" tags carrying this marker. */
export const refs = (event: UnsignedEvent, marker: string): string[] => event.tags.filter((tag) => tag[0] === "e" && tag[3] === marker).map((tag) => tag[1] as string);
