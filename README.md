# Tower

**[tower.rahultrikha.com](https://tower.rahultrikha.com)**

A control tower for [pi](https://pi.dev) coding-agent sessions. Queue work for many projects on one board, let an expensive model plan and a cheap model build, have your test suite judge the result, and step in only where a decision is yours.

- **One board, every project.** A swimlane per project, a column per stage: backlog, planning, building, testing, feedback, pull request, done.
- **Model tiering.** Planning defaults to `anthropic/claude-fable-5-1`; building and testing default to `zai/glm-5.3`. Override per card.
- **Isolation.** Every card gets its own git worktree and branch; your checkout is never touched. (One exception: a repository with no commits at all gets an empty first commit, made without touching your files or index, because a branch needs a commit to start from.) Every stage is a fresh pi session that sees only the previous stage's artifacts (for example `plan.md`), never its conversation.
- **Gates.** A finished plan waits for you: approve it, or send it back with what should change.
- **Your tests decide.** A project's verify command runs after each build; its exit code is the verdict. Failures go back to a fresh builder with the output, up to a cap, then the card asks for you.
- **Live and steerable.** Every session streams to the board. Steer it mid-run, abort it, read its diff.
- **Survives restarts.** The queue is persisted; sessions interrupted by a restart resume in the same pi session.

Status: milestones 0 to 4 of 6. The feedback gate with review flows, pull requests with CI watching, routing on retry, cost roll-ups and ad hoc skills are not built yet; a card that passes testing currently rests there. See the [design and roadmap](docs/superpowers/specs/2026-09-21-tower-design.md).

## Install as a pi package

Requires [pi](https://pi.dev), git, npm and **Node 22.18 or newer** (the daemon runs its TypeScript directly).

```sh
pi install git:github.com/rahult/tower
```

pi clones the repository to `~/.pi/agent/git/github.com/rahult/tower` and installs its dependencies. That adds one command, `/tower`, to every pi session. To try it without installing: `pi -e git:github.com/rahult/tower`.

> pi packages run with full access to your machine, and Tower runs coding agents that execute shell commands in your repositories. Read the source first.

### Start using it

Start pi **from a shell that has your provider API keys** (`ZAI_API_KEY`, `DEEPSEEK_API_KEY`, and so on). The daemon inherits that environment, and the sessions it spawns inherit it from the daemon. Providers you logged into with pi's `/login` work as usual.

```text
/tower
```

The first run builds the board UI (a few seconds), starts the daemon in the background and opens <http://127.0.0.1:4700>. The daemon keeps running after you quit pi.

| Command | What it does |
|---|---|
| `/tower` | Start the daemon if needed and open the board |
| `/tower add <title>` | Add a card for the current repository to its backlog. The repository becomes a project the first time |
| `/tower run <title>` | Add a card and start it: planning begins when a slot is free |
| `/tower status` | What is running, and what is waiting for you |
| `/tower settings` | Show which model runs each stage |
| `/tower settings planning=zai/glm-5.3 building=zai/glm-5.3-flash:low` | Set them. `:thinking` is optional; `stage=default` clears one |
| `/tower stop` | Stop the daemon. Sessions that were running can be resumed from the board next time |

A first card, end to end:

1. In a pi session inside one of your repositories: `/tower run Add retry with backoff to the HTTP client`.
2. On the board, open the project's **Settings** and set a **verify command** (for example `pnpm test && pnpm typecheck`) and, if a fresh checkout needs it, a **setup command** (for example `pnpm install --prefer-offline`). Without a verify command an agent judges the build instead of your tests.
3. The card plans, then turns amber: **Review**. Read the plan; approve it, or send it back with a note.
4. A cheap model builds from the plan in the card's worktree and commits on branch `tower/<id>-<title>`. Your verify command runs. If it fails, a fresh builder gets the output and tries again (three builds by default).
5. Open the card any time to watch the session, **steer** it ("use the existing logger"), abort it, or read its diff under **Changes**.

Click a strip to open its card. Strip colour is state: buff is resting, blue is running, amber needs you, green is done.

### Update and remove

```sh
pi update git:github.com/rahult/tower
pi remove git:github.com/rahult/tower
```

Your data lives in `~/.tower` and is not touched by either.

## Run it without pi's package manager

```sh
git clone https://github.com/rahult/tower && cd tower
pnpm install        # or: npm install
pnpm build          # build the board UI
pnpm start          # daemon and board on http://127.0.0.1:4700
```

## Configuration

Environment variables, read when the daemon starts:

| Variable | Default | Purpose |
|---|---|---|
| `TOWER_HOME` | `~/.tower` | Database, card folders (`cards/<id>/`), worktrees, `daemon.log` |
| `TOWER_PORT` | `4700` | Port. The daemon only ever binds `127.0.0.1`; there is no authentication |
| `TOWER_MAX_CONCURRENT` | `3` | Sessions and verify commands running at once, across all projects |
| `TOWER_MAX_BUILD_ATTEMPTS` | `3` | Builds per card before a failing test stops the loop |

### Models

Which model runs each stage is stored in `~/.tower/config.json`. Change it from the board (**Models**, top right), with `/tower settings` in pi, or by editing the file and restarting Tower:

```json
{
  "models": {
    "planning": { "model": "zai/glm-5.3", "thinking": "high" },
    "building": { "model": "zai/glm-5.3-flash", "thinking": "low" }
  }
}
```

Names are pi's `provider/model-id` selectors (`pi --list-models`). A stage you leave out uses Tower's default (planning `anthropic/claude-fable-5-1`, building and testing `zai/glm-5.3`). Changes apply to the next session that starts. Precedence is card, then project, then `config.json`, then the default.

If a provider rejects a request (no credit, a bad key, an unknown model), the card stops and shows the provider's own message.

Per project, under **Settings** on its lane: the verify command, the setup command, and how many of its cards may run at once (default 1).

Per card, models can be overridden when creating it through the API:

```sh
curl -X POST http://127.0.0.1:4700/api/cards -H 'content-type: application/json' -d '{
  "projectId": "<id>", "title": "Add a farewell function",
  "stageConfig": { "planning": { "model": "zai/glm-5.3", "thinking": "low" } }
}'
```

Stage defaults are in `packages/core/src/stage-spec.ts`.

### How sessions are run

Each stage is a `pi --mode rpc` process in the card's worktree, started with `--no-extensions` and without project trust, because pi has no tool-approval step and your global pi config may load many extensions. Stages hand off through files in `~/.tower/cards/<id>/`, and every stage ends by writing `stage-result.json`; the daemon asks once more if it is missing, then flags the card.

You can open any card's session in the normal pi TUI while Tower is not running it:

```sh
cd <the card's worktree> && pi --session-dir ~/.tower/cards/<id>/sessions --session <session id>
```

## Make it yours

Four small functions in `packages/core/src/policy/` hold the product's opinions. Each ships with a deliberately naive default and a comment describing the trade-off:

| Function | Default | The question |
|---|---|---|
| `requiredGates` in `gates.ts` | always gate | When may a small plan skip your approval? |
| `decideAfterFailure` in `retry.ts` | count to the cap | Stop early when the same error repeats? How much output does the builder get? |
| `pickNext` in `scheduler.ts` | oldest first | Keep every lane moving, or finish what is started? |
| `pickModel` in `model-routing.ts` | configured model | Escalate to a stronger model after a failed build? |

The concurrency caps are enforced outside `pickNext`, so a policy can only choose among cards that are allowed to start.

## Development

```sh
pnpm dev                                  # daemon with --watch, Vite on http://127.0.0.1:4701
pnpm test && pnpm typecheck               # no model calls
pnpm build && node packages/daemon/test/demo.ts   # seeded board on the fake driver, http://127.0.0.1:4720
```

- `packages/core`: pure domain with no IO. The card lifecycle is one function, `transition(card, event)` in `card-machine.ts`; the daemon's orchestrator is its only caller.
- `packages/daemon`: Hono API and SSE, SQLite (`node:sqlite`), scheduler, stage runner, verifier. Only `src/pi/` knows pi exists; everything else talks to the `SessionDriver` interface, and the tests run the whole daemon against a scripted fake.
- `packages/web`: the React board.
- `pi/tower.ts`: the pi extension.
- `site/`: the static project site (plain HTML, CSS and one script; no build step). Pushing changes under `site/` to `main` deploys it to GitHub Pages.
- `prompts/`: stage prompt templates. They are not pi prompt templates; the explicit `pi` manifest in `package.json` keeps pi from loading them.
