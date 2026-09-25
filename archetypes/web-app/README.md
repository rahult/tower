# web-app

A full-stack application baseline: a React + Vite frontend, a zero-dependency Node backend with a real
SQL database, unit tests, and an acceptance runner. It exists so that every feature is planned, built and
verified against the same conventions — the house does not reinvent its toolchain per feature.

## Where things live

```
server/           the backend: zero runtime dependencies (node:http + node:sqlite)
  app.ts          routing, JSON parsing, validation, error handling
  db.ts           the database: schema and typed queries
  test/           unit tests (vitest) — every behavior the API exposes has one
web/              the frontend: React 19 + Vite, no CSS framework
  src/App.tsx     the app shell and screens
  src/api.ts      the typed client for the backend
scripts/
  dev.mjs         runs backend (watch) + frontend (vite) together
  acceptance.mjs  the acceptance runner: boots the built backend, runs every spec
acceptance/
  specs/          acceptance specs — one file per behavior, plain ESM
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | backend on :8787 (watch mode) + frontend on :5173 |
| `npm test` | unit tests |
| `npm run verify` | typecheck + tests + build — the bar every change must clear |
| `npm run accept` | acceptance specs against a freshly built, freshly seeded backend |
| `npm run accept -- --expect-red` | the red gate: exits 0 only when the specs this branch adds or changed all run and fail |

## The acceptance contract

Acceptance specs are the behavioral definition of done. Each file in `acceptance/specs/` exports:

```js
export const name = "creating the same note twice yields one note";

export async function run({ baseUrl }) {
  const first = await createNote(baseUrl, "milk");
  const second = await createNote(baseUrl, "milk");
  assert(second.status === 409, `expected 409 for a duplicate, got ${second.status}`);
}
```

- `run({ baseUrl })` talks to the running application through its HTTP API — never through internals,
  never by importing server code.
- The runner boots the backend with a **throwaway database** (empty every run), so specs may assume a
  clean slate; use distinct data when two specs must not meet.
- Helpers live in `acceptance/helpers.mjs` (`assert`, `expectStatus`, `json`).
- The green gate is `npm run accept`: exit 0 only when every spec passes. The red gate adds
  `--expect-red`: exit 0 only when **the specs this branch adds or changes** all fail, judged against
  the merge-base with the default branch — pre-existing specs legitimately pass, so the red gate
  reports them as `SKIP` and judges only the branch's own specs. No specs at all, or a branch that
  adds none, fails both gates — unless the branch commits `acceptance/NO-NEW-BEHAVIOR` with a
  one-line justification: a behavior-less card (hygiene, refactor) has nothing to turn red, and is
  gated by its unit tests, `npm run verify`, and every existing spec at green.

## House rules

1. **Test-first.** Behavior is specified before it is implemented: acceptance specs at the API
   boundary, unit tests for the modules underneath. A feature without tests is not done.
2. **Never weaken a test to make it pass.** If a spec is wrong, changing it is a decision that
   belongs in the plan, not a convenience.
3. **The backend stays dependency-free.** `node:http`, `node:sqlite`, the standard library. A
   dependency needs a reason a plan states.
4. **Validation lives at the boundary.** Every route validates its inputs (shape, length, type) and
   answers `400` with a JSON error before touching the database; unknown routes answer `404`.
5. **The frontend is accessible by default.** Labelled inputs, real buttons, focus styles, `aria-live`
   for async outcomes, keyboard-complete flows. No interaction that requires a mouse.
6. **Commits say what and why**, one concern per commit.
