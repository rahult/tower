import assert from "node:assert/strict";

export { assert };

/** Expects a response's status and returns it with the parsed body, failures carrying the payload. */
export async function expectStatus(response, status, what) {
	const text = await response.text();
	assert(response.status === status, `${what}: expected ${status}, got ${response.status} — ${text.trim().slice(0, 200)}`);
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function json(response) {
	return JSON.parse(await response.text());
}
