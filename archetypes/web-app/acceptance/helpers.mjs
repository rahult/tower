// Tiny assertion helpers for acceptance specs. A failing helper throws; the runner records the spec.
export function assert(condition, message) {
	if (!condition) throw new Error(message || "assertion failed");
}

/** The response must carry exactly this status, or the spec fails with a readable reason. */
export async function expectStatus(response, status, what = "the call") {
	if (response.status !== status) {
		const body = await response.text().catch(() => "");
		throw new Error(`${what}: expected ${status}, got ${response.status}${body ? ` (${body.slice(0, 200)})` : ""}`);
	}
	return response;
}

/** The response must be a success (2xx) and is returned as parsed JSON. */
export async function json(response) {
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`expected a success, got ${response.status}${body ? ` (${body.slice(0, 200)})` : ""}`);
	}
	return response.json();
}
