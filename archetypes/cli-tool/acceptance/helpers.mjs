import assert from "node:assert/strict";

export { assert };

/** Expects an outcome's exit status and returns it, with the output in the failure message. */
export function expectStatus(outcome, status, what) {
	assert(outcome.status === status, `${what}: expected exit ${status}, got ${outcome.status} — ${(outcome.stderr || outcome.stdout).trim().slice(0, 200)}`);
	return outcome;
}
