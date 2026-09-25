# API service

A zero-dependency Node HTTP JSON API: boundary-validated routes, `node:sqlite` storage, vitest unit
tests, and an acceptance runner that boots the server and drives it over HTTP. The baseline for
headless services built test-first.

| Command | What it does |
|---|---|
| `npm run dev` | the API on `$PORT` (default 8901) |
| `npm test` | unit tests |
| `npm run verify` | the bar every change must clear (tests) |
| `npm run accept` | acceptance specs against a freshly booted, freshly seeded server |
| `npm run accept -- --expect-red` | the red gate: exits 0 only when the specs this branch adds or changes all run and fail |

## The acceptance contract

Each file in `acceptance/specs/` exports a human-readable `name` and a `run` that drives the server:

```js
import { assert, expectStatus } from "../helpers.mjs";

export const name = "creating an item appears in the list";

export async function run({ baseUrl, fetch }) {
	const created = await expectStatus(fetch(`${baseUrl}/api/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "milk" }) }), 201, "create item");
	const list = await expectStatus(fetch(`${baseUrl}/api/items`), 200, "list items");
	assert((await list.body).some((item) => item.name === "milk"), "the created item is missing");
}
```

- The server boots with a **throwaway database** (empty every run), so specs may assume a clean
  slate; use distinct data when two specs must not meet.
- The green gate is `npm run accept`: exit 0 only when every spec passes. The red gate adds
  `--expect-red`: exit 0 only when **the specs this branch adds or changes** all fail, judged against
  the merge-base with the default branch; pre-existing specs report `SKIP`. A behavior-less branch
  commits `acceptance/NO-NEW-BEHAVIOR` with a one-line justification instead.

## House rules

1. **Test-first.** Acceptance specs drive the real server over HTTP; unit tests own the modules
   underneath.
2. **Never weaken a test to make it pass.**
3. **The backend stays dependency-free.** `node:` built-ins only; a dependency needs a reason a plan
   states.
4. **Validation lives at the boundary.** Every route validates its inputs (shape, length, type)
   before the store sees a value.
5. **A handler that throws is a bug**: 500, logged, never a hung socket.
