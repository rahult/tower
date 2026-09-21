# Traffic Control

A control tower for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent sessions: queue work per project, watch every session live, steer it, and decide which model does what.

Design and roadmap: [`docs/superpowers/specs/2026-09-21-traffic-control-design.md`](docs/superpowers/specs/2026-09-21-traffic-control-design.md).

## Status

Milestone 4 of 6. The board has one **swimlane per project** and one column per stage. A card goes from the backlog through **planning** (expensive model), waits at a **plan approval gate**, is **built** by a cheap model in a fresh session that sees only the plan, and is then **tested**: the project's verify command runs in the card's worktree and its exit code decides; failures go back to a fresh builder with the output, up to a cap. A **scheduler** starts queued work under a global cap and a per-project cap, the queue survives restarts, and sessions interrupted by a restart can be **resumed** in the same pi session. Every session streams live and can be steered and aborted.

Still to come: the feedback gate with review flows (adversarial, SOLID), pull requests with CI watching (milestone 5), and model routing on retry, cost roll-ups, ad hoc skills and extension questions (milestone 6). Backlog drag-and-drop ordering was deferred: nothing reads the order yet.

## Run it

Requires Node 24+ and pnpm. Start the daemon from a shell that has your provider API keys: pi sessions inherit the daemon's environment.

```sh
pnpm install
pnpm build    # build the web UI
pnpm start    # daemon + UI on http://127.0.0.1:4700
```

For development, `pnpm dev` runs the daemon with `--watch` and Vite on http://127.0.0.1:4701.

| Variable | Default | Purpose |
|---|---|---|
| `TC_HOME` | `~/.traffic-control` | Database, card folders (`cards/<id>/`), worktrees |
| `TC_PORT` | `4700` | Daemon port (always bound to 127.0.0.1) |
| `TC_MAX_BUILD_ATTEMPTS` | `3` | Builds per card before a failing test stops the loop |
| `TC_MAX_CONCURRENT` | `3` | Sessions and verify commands running at once, across all projects |

Per project (Settings on its bay): a **verify command** (for example `pnpm test && pnpm typecheck`) and a **setup command** that runs once in each new worktree (for example `pnpm install --prefer-offline`). Without a verify command, a tester agent judges the build instead.

## How a stage runs

Each stage is a fresh `pi --mode rpc` process in the card's worktree, with `--no-extensions` and no project trust unless the project opts in. Stages hand off through files in `cards/<id>/` (for example `plan.md`), and every stage must finish by writing `stage-result.json`; the daemon nudges once if it is missing, then flags the card.

The card lifecycle is one pure function, `transition(card, event)` in `packages/core/src/card-machine.ts`; the daemon's orchestrator is its only caller. Policies you are meant to edit live in `packages/core/src/policy/`.

Stage defaults live in `packages/core/src/stage-spec.ts` (expensive model plans, cheap model builds) and can be overridden per card with `stageConfig`.

## Layout

- `packages/core` — pure domain: types, stage specs, config precedence, prompt rendering, policies. No IO.
- `packages/daemon` — Hono API + SSE, SQLite, stage runner. Only `src/pi/` knows pi exists; everything else uses the `SessionDriver` interface, and tests run the whole daemon against a scripted fake.
- `packages/web` — React UI.
- `prompts/` — stage prompt templates.
- `spikes/` — throwaway M0 spike that verified the pi integration and recorded the test fixture.

## See the UI without spending tokens

```sh
pnpm build && node packages/daemon/test/demo.ts   # http://127.0.0.1:4720
```

Boots the real daemon on a scripted fake driver and seeds three projects with cards in every state.

## Test

```sh
pnpm test        # unit + daemon integration (no model calls)
pnpm typecheck
```
