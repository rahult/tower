# Traffic Control

A control tower for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent sessions: queue work per project, watch every session live, steer it, and decide which model does what.

Design and roadmap: [`docs/superpowers/specs/2026-09-21-traffic-control-design.md`](docs/superpowers/specs/2026-09-21-traffic-control-design.md).

## Status

Milestone 1 of 6. You can add projects and cards, run the **planning** stage of a card in its own git worktree, watch the session stream, steer it, abort it, and read the plan it writes. Gates, building, testing, the swimlane board, review flows and pull requests come in later milestones.

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

## How a stage runs

Each stage is a fresh `pi --mode rpc` process in the card's worktree, with `--no-extensions` and no project trust unless the project opts in. Stages hand off through files in `cards/<id>/` (for example `plan.md`), and every stage must finish by writing `stage-result.json`; the daemon nudges once if it is missing, then flags the card.

Stage defaults live in `packages/core/src/stage-spec.ts` (expensive model plans, cheap model builds) and can be overridden per card with `stageConfig`.

## Layout

- `packages/core` — pure domain: types, stage specs, config precedence, prompt rendering, policies. No IO.
- `packages/daemon` — Hono API + SSE, SQLite, stage runner. Only `src/pi/` knows pi exists; everything else uses the `SessionDriver` interface, and tests run the whole daemon against a scripted fake.
- `packages/web` — React UI.
- `prompts/` — stage prompt templates.
- `spikes/` — throwaway M0 spike that verified the pi integration and recorded the test fixture.

## Test

```sh
pnpm test        # unit + daemon integration (no model calls)
pnpm typecheck
```
