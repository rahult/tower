# Traffic Control — control tower for pi sessions

## Context

Rahul runs the `pi` coding agent (v0.85.1) across many projects at once and has no single place to queue work, see what every session is doing, steer it, or control which model does what. Traffic Control is a local web app backed by a long-running daemon. It owns a kanban board (one swimlane per project), drives each card through `planning → building → testing → feedback → pull request → done`, and spawns and steers pi sessions to do the work: expensive models (Fable 5.1, Astra) plan and review, cheap models (GLM 5.3, Kimi K3, DeepSeek V4, Qwen 3.8) write code.

The repo `/Volumes/Atlas/Code/projects/traffic-control` is empty (no commits). Greenfield.

## Decisions made with the user

| Topic | Decision |
|---|---|
| Interface | Local web app served by a daemon on `127.0.0.1`; sessions outlive the browser tab |
| Stage movement | Auto-advance with human gates: **approve plan** before building, **feedback** before PR. Test failures loop back to building with a retry cap |
| Foundation | Standalone Node/TypeScript daemon; one `pi --mode rpc` child per running stage via pi's exported `RpcClient`. Not pi-workflows, not terminal panes |
| Context handoff | Fresh pi session per stage; handoff through artifact files in a per-card folder |
| Reviews | Project-configured review flows auto-run on entering feedback; any flow/skill/agent can also be run on demand |
| PR stage | Daemon watches the PR via `gh`: CI failure → cheap model fixes (retry cap); merged → Done + worktree/branch cleanup; review comments shown on the card, one click sends them to the builder |

## Verified facts the design relies on

`$PI` = `/Volumes/Atlas/mac-offload/caches/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent`

- Package is published (`@earendil-works/pi-coding-agent`, pin `0.85.1`), ESM-only, `exports` exposes only `"."` — import `RpcClient` from the root; no deep imports. ~0.8 s import cost.
- `RpcClient` spawns `node <cliPath>`; default `cliPath` is relative → config must hold **absolute `node` and `cliPath`** (fnm shim paths do not survive launchd).
- Every RpcClient command has a **30 s timeout**; `waitForIdle`/`promptAndWait` default to **60 s** and subscribe at call time. → never use `promptAndWait`, `waitForIdle`, or `client.bash()`. The driver owns one permanent `onEvent` subscription and an idle promise keyed on **`agent_settled`** (not `agent_end`).
- `extension_ui_request` reaches `onEvent` (untyped) but **cannot be answered through the public API** (`send()` is private and overwrites the id). Fix: subclass that writes `{type:"extension_ui_response", id, ...}` to the child's stdin, as `$PI/examples/rpc-extension-ui.ts` does. Only `select/confirm/input/editor` block; `notify/setStatus/...` are fire-and-forget.
- `entry_appended` fires **only for extension custom entries**, never for messages (verified in M0 spike) → the durable transcript anchors on `message_end` (authoritative; `message_update` is delta-only) and uses `getEntries(since)` at settle time as the restart-safe cursor.
- `--session-id <id>` creates-or-resumes (cwd-scoped; ids match `^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$`). `--session-dir <dir>` keeps a card's sessions in the card folder.
- Skills: `/skill:<name> <args>` as prompt text (via `prompt`, not `steer`); `--skill <path>` force-loads. `--append-system-prompt` accepts a file. pi core has **no agents concept** — `~/.pi/agent/agents/*.md` frontmatter (`model`, `tools`, `thinking`, body) must be translated to CLI flags by Traffic Control.
- `--approve`/`-na` is **project trust**, not tool approval; pi has no tool-approval gate. With the user's `defaultProjectTrust: "always"` and 10 globally installed extension packages, stage defaults are **`--no-extensions` + `-na`**, with a per-project extension allowlist and trust opt-in. Worktree isolation is the only write guard.
- No session or repo locks in pi → one git worktree per card, one writer per session file, one write-lease per worktree.
- zai / deepseek / minimax / moonshot auth via env vars → daemon passes its env to children and must be started from a shell that has them.
- Plan-based models (`zai/*`, `kimi-coding/*`, `qwen-token-plan-individual/*`) report `cost: 0` → UI leads with **tokens**, dollars secondary with a "plan-based" badge.
- Model selectors available: `anthropic/claude-fable-5-1`, `anthropic/claude-opus-5`, `openai-codex/gpt-6-astra`, `zai/glm-5.3`, `kimi-coding/k3`, `deepseek/deepseek-v4-pro`, `qwen-token-plan-individual/qwen3.8-max`. Catalog: `~/.pi/agent/models-store.json`.
- Reusable: skills `code-review`, `grilling`, `tdd`, `commit`, `iterate-pr`; agent role files. No adversarial-review or SOLID-review exists — they ship here as flows.

## Architecture

```
Browser (React) ──REST + one multiplexed SSE stream──▶ Daemon (Node 24, Hono, node:sqlite)
                                                        ├─ Orchestrator ── core.transition() → effects
                                                        ├─ Scheduler (global + per-project caps)
                                                        ├─ RunManager ── SessionDriver ──▶ pi --mode rpc (1 per run, cwd = card worktree)
                                                        ├─ Verifier (project verifyCommand, authoritative pass/fail)
                                                        ├─ FlowRunner (review flows, ad hoc skills/agents)
                                                        ├─ WorktreeManager (git worktree per card)
                                                        └─ PrWatcher (gh: create, CI status, merge, comments)
~/.traffic-control/  config.json · tc.sqlite · worktrees/<project>/<card>/ · cards/<id>/{plan.md, test-report.md, reviews/, stage-result.json, sessions/}
```

**Stack:** pnpm workspace; TypeScript run via Node 24 native type stripping (erasable syntax only), `tsc --noEmit` for checking; **Hono** + `@hono/node-server`; **SSE** (not WebSocket — `Last-Event-ID` gives reconnect/replay for free; one multiplexed `GET /api/stream?topics=board,run:<id>`); **`node:sqlite`** with `PRAGMA user_version` + ordered SQL-string migrations, WAL; React 19 + Vite + Tailwind v4 + TanStack Query, transcript via `useSyncExternalStore` (never per-delta React state); **Vitest**. Dev: Vite proxies `/api` to the daemon. Prod: daemon serves `packages/web/dist`.

**Two state axes per card** (kept separate): `stage` = board column (`backlog|planning|building|testing|feedback|pull_request|done`); `status` = `idle|queued|running|verifying|awaiting_gate|awaiting_input|needs_attention|paused|interrupted|abandoned`. A pure `transition(card, event, policy) → {next, effects}` in `core` is the only place lifecycle rules live; the daemon's `orchestrator.ts` is the only caller and the only executor of effects.

**Stage contract:** prompt template (`prompts/<stage>.md`) + model + thinking + tool allowlist + expected artifact + a `stage-result.json` (`{status: pass|fail|blocked, summary}`) written by the agent to the card folder by absolute path. Missing result → one follow-up nudge → `needs_attention`. In testing, the project's `verify_command` run by the daemon is authoritative when set. New worktrees run the project's `setup_command` once (fresh worktrees have no `node_modules`).

**Flows:** YAML files (`flows/*.flow.yaml`, plus `~/.traffic-control/flows/`). A flow is an ordered list of steps; each step = skill ref | agent-file ref | prompt file, with model, thinking, read-only vs write tools, and an output artifact under `cards/<id>/reviews/`. Sequential in v1. Ships with `adversarial-review` and `solid-review` (read-only, expensive model, never sees the builder's session). Findings can be sent to building as a fix prompt. Ad hoc actions from the card drawer: run flow, run `/skill:x`, run agent file, send prompt with model X.

**Transcript:** per-run monotonic `seq`; in-memory ring buffer (5 000 items / 4 MB) with text deltas coalesced on a 50 ms flush; SSE handler emits the buffered snapshot first when `since=0`, then live. SQLite `events` stores anchors only (`message_end`, tool start/end, stage/gate/run changes, verify output) — never deltas — so finished runs replay exactly.

**Recovery:** on boot, runs left `running` become `interrupted`; Resume respawns with the same `--session-id`, `--session-dir`, cwd and a continue prompt. `git worktree list --porcelain` is reconciled against the DB.

**Open in TUI:** `cd <worktree> && pi --session-dir ~/.traffic-control/cards/<id>/sessions --session <sessionId>`, enabled only when no RPC child holds that session.

### SQLite tables
`projects` (repo_path, default_branch, setup_command, verify_command, trust_project_pi, extensions_json, concurrency_limit, stage_config_json) · `cards` (project_id, title, brief, stage, status, priority, position, branch_name, worktree_path, base_commit, attempt, stage_config_json, pr_url, pr_state, needs_attention_reason) · `stage_runs` (id = pi session id e.g. `c42-build-3`; kind stage|flow_step|adhoc; model, thinking, args_json, status, result_status, tokens_json, cost_usd, last_entry_id, pid) · `gates` (kind plan_approval|feedback, status, feedback; unique pending gate per card) · `artifacts` · `flow_runs` · `ui_requests` · `events` (seq autoincrement, card_id, run_id, type, payload_json) · `settings`. Cost roll-ups are `GROUP BY` queries over `stage_runs`; no ledger table.

### API
REST: `GET /api/board` · `POST/PATCH /api/projects` · `POST/PATCH /api/cards` · `POST /api/cards/:id/{enqueue,pause,resume,abort,retry,force-stage,steer,flows,adhoc}` · `POST /api/cards/:id/gates/:gateId` · `GET /api/cards/:id{,/diff,/artifacts,/tui-command}` · `GET /api/runs/:id/transcript?since=` · `POST /api/runs/:id/ui/:requestId` · `GET /api/{models,flows,skills}` · `GET /api/stream` (SSE).
SSE board topic: `board.card_upserted`, `card.stage_changed`, `card.status_changed`, `gate.opened/decided`, `ui.requested/resolved`, `pr.updated`, `cost.updated`. Run topic: `run.started/text/thinking/tool_start/tool_end/message/queue/settled/stats`, `verify.output/finished`, `run.gap`.

## Layout

```
flows/{adversarial-review,solid-review}.flow.yaml
prompts/{planning,building,testing,pr-fix,pr-body}.md + partials/stage-result-contract.md
spikes/rpc-spike.ts                       # M0, throwaway
packages/core/src/
  types.ts  card-machine.ts  effects.ts  stage-spec.ts  stage-config.ts (card > project > global > default)
  flow.ts  prompt-render.ts  stage-result.ts  agent-file.ts  models.ts
  policy/{model-routing,scheduler,retry,gates}.ts      # user-written, see below
packages/daemon/src/
  main.ts  config.ts  orchestrator.ts  scheduler.ts  stage-runner.ts  flow-runner.ts  verifier.ts  recovery.ts
  db/{open,migrate,repo-*.ts}
  pi/session-driver.ts   # THE SEAM: SessionDriver + RunHandle + normalised DriverEvent union
  pi/pi-driver.ts        # RpcClient subclass (stdin UI responses, exit hook), idle tracking
  pi/argv.ts             # RunSpec → string[] (pure, snapshot-tested)
  pi/fake-driver.ts  pi/recording-driver.ts
  run/{run-manager,transcript-buffer,ui-request-broker}.ts
  git/{worktree-manager,diff,setup}.ts   pr/{gh,pr-watcher}.ts
  events/{bus,sse}.ts   http/{server,routes-*,static}.ts
packages/web/src/
  api/{client,queries,stream}.ts  board/{Board,Swimlane,Column,CardTile}.tsx
  card/{Drawer,Transcript,SteerBox,GatePanel,FlowLauncher,ArtifactsPanel,DiffPanel,CostPanel,UiRequestPanel}.tsx
  settings/{ProjectForm,ModelPicker}.tsx
```

Only `pi/*` knows pi exists; everything else talks to `SessionDriver`, so a pi upgrade touches one folder and the daemon is testable with `FakeSessionDriver` replaying real recorded fixtures.

## Milestones (each a usable vertical slice)

**M0 — Spike (throwaway, one file).** First commit the design doc to `docs/superpowers/specs/2026-09-21-traffic-control-design.md`. Then `spikes/rpc-spike.ts` proves, printing a pass/fail checklist: import `RpcClient` from an npm dependency; spawn with absolute `cliPath` in a git worktree with `--session-dir`, `--session-id`, `--no-extensions`, `-na`, `--model zai/glm-5.3`; stream deltas and see `agent_settled` after `agent_end`; steer mid-run; `getSessionStats` tokens non-zero; kill and resume by the same session id with `getEntries(since)`; **write an artifact outside the worktree by absolute path** (verified: pi's write tool is not cwd-confined); answer an `extension_ui_request` via stdin; use a model not in `enabledModels`. Save the raw event JSONL to `packages/daemon/test/fixtures/`.

**M1 — One project, one card, planning runs live in the browser.** core types/stage-spec/prompt-render/stage-result; daemon config, db, pi driver, run-manager, transcript-buffer, stage-runner, worktree-manager, SSE, HTTP; minimal web (card list, drawer, transcript, steer box, abort). Verify: add a project, create a card, Run → worktree created, transcript streams, `plan.md` + `stage-result.json` appear; close and reopen the tab → transcript replays and continues.

**M2 — Plan gate + building handoff.** `card-machine.ts`, `policy/gates.ts`, `orchestrator.ts`, gates repo, diff, GatePanel, DiffPanel. Verify: card waits at `awaiting_gate` showing rendered plan; Reject+feedback re-plans; Approve starts a run with a different session id whose first message contains only the plan; diff panel shows real changes.

**M3 — Testing, verify command, fail loop.** `verifier.ts`, `policy/retry.ts`, `setup_command`, needs-attention UI. Verify: a repo with a deliberately failing test bounces building↔testing up to the cap, then lands in `needs_attention` with the verify output.

**M4 — The board: swimlanes, backlog queue, scheduler, recovery.** `policy/scheduler.ts`, `scheduler.ts`, `recovery.ts`, board components; drag-and-drop (`@dnd-kit`) **only for ordering the backlog** — stage columns are state-derived, manual moves go through an audited "force stage" action. Verify: 6 cards over 2 projects with global cap 2 / per-project cap 1 → exactly 2 run; kill the daemon mid-run, restart → `interrupted` with a working Resume.

**M5 — Feedback, flows, PR watch.** `flow.ts`, `agent-file.ts`, `flow-runner.ts`, `pr/gh.ts` (always `--title --body-file --base --head`, `GH_PROMPT_DISABLED=1`), `pr/pr-watcher.ts` (polls only cards in `pull_request`, ~2 min; CI failure → `pr-fix` run with failing logs, retry cap; merged → done + cleanup; comments listed with "send to builder"), flow YAMLs, FlowLauncher, ArtifactsPanel. Verify: entering feedback produces two review artifacts before the gate opens; reject → build prompt contains findings; approve → PR opened with a live link; merge on GitHub → card moves to Done and the worktree is removed.

**M6 — Model tiering, cost, ad hoc actions, extension UI.** `policy/model-routing.ts`, `models.ts`, `stage-config.ts`, `ui-request-broker.ts` (daemon-side timeout → `cancelled`), ModelPicker, CostPanel, UiRequestPanel. Verify: project-level plan=`anthropic/claude-fable-5-1:high`, build=`zai/glm-5.3`, one card overridden — confirmed in `stage_runs.args_json`; ad hoc `/skill:grilling` on a card; an allowlisted UI-emitting extension's question answered from the drawer.

**Deferred (YAGNI for v1):** budget enforcement (spend is shown, not enforced), parallel flow steps, rich side-by-side diff viewer (v1 = coloured `git diff` text), in-browser artifact editing, auth/remote access, card dependencies/labels/search, notifications, session fork/clone UI, compaction handling, `tc` CLI.

## User-written policy functions (learning mode)

Four small pure functions in `packages/core/src/policy/` are where the product opinion lives. Each is scaffolded with signature, trade-off comment, tests-as-spec and a naive default; Rahul writes the 5–10 line body when its milestone arrives.

1. `model-routing.ts` — `pickModel({stage, attempt, kind, config, lastResult, catalog})`: does a failed cheap build retry on the same model, escalate, or escalate only on a repeated failure? (M6, stubbed from M1)
2. `gates.ts` — `requiredGates({card, project, planArtifact})`: when, if ever, is the plan gate skipped? (M2)
3. `retry.ts` — `decideAfterFailure({attempt, maxAttempts, verifyOutput, previousVerifyOutput})`: counter only, or stop early on the same error twice; how much output to feed back? (M3)
4. `scheduler.ts` — `pickNext({ready, running, caps})`: round-robin across swimlanes vs finish-what's-started; does a card returning from a test failure jump the queue? (M4)

## Testing

- **core:** table-driven tests per transition row; property tests (fast-check) for invariants — at most one active run per card, `attempt ≤ cap + 1`, `awaiting_gate` ⇔ exactly one pending gate, `abort` reachable everywhere. Snapshot tests for rendered prompts and for `argv.ts` (the regression guard for pi CLI drift).
- **daemon:** integration only, through the real HTTP/SSE surface on port 0 with a temp SQLite file, a temp `git init` repo and `FakeSessionDriver` replaying M0 fixtures. Cases: full happy path, plan rejection, fail loop to cap, crash → needs_attention, missing result → nudge, pause/resume, abort, restart mid-run, concurrency caps, mid-run drawer open with no duplicate or missing `seq`, SSE reconnect via `Last-Event-ID`. `gh` tested with a fake `gh` script on PATH. `WorktreeManager` tested against a temp repo.
- **Real-pi smoke test:** opt-in via `TC_REAL_PI=1`; one planning stage on a temp repo with `zai/glm-5.3`, `--no-extensions`, `--tools read,write,ls`; asserts `plan.md`, a valid `stage-result.json`, non-zero tokens.

## End-to-end verification

1. `pnpm test` green (core + daemon integration); `pnpm typecheck` clean.
2. `TC_REAL_PI=1 pnpm -C packages/daemon test smoke` passes.
3. `pnpm dev`, open the board, add two real projects, queue cards in each, and drive one card all the way: approve plan → build by a cheap model → verify passes → adversarial + SOLID findings present at the feedback gate → approve → PR opens → merge → card in Done, worktree gone. During the run: steer mid-build, pause/resume, restart the daemon once and resume the interrupted run, open the session in the pi TUI with the copied command.
