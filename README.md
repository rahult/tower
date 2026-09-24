# Tower

**[tower.rahultrikha.com](https://tower.rahultrikha.com)**

A control tower for [pi](https://pi.dev) coding-agent sessions. Queue work for many projects on one board, let an expensive model plan and a cheap model build, have your test suite judge the result, and step in only where a decision is yours.

- **Attention first.** The board opens on **Focus**: everything that needs you in one amber tray — plans to approve, questions to answer, findings to judge — each with its action right on the row, then the work in flight, then the backlog. Empty trays do not render.
- **One board, every project.** A swimlane per project, a column per stage: backlog, planning, building, testing, feedback, pull request, done. Done folds away until you want it; **Projects** and **Usage** have their own views.
- **Keyboard included.** `⌘K` opens a command palette (add work, jump to a card, switch views, theme); `n` starts a new card; `⌘1–4` switch views. Cards are deep-linkable (`#card/<id>`).
- **Nudged when away.** Turn on notifications and a card that starts waiting for you pings the browser while the tab is hidden; the tab title carries the count when it is visible.
- **Model tiering.** Planning defaults to `anthropic/claude-fable-5-1`; building and testing default to `zai/glm-5.3`. Override per card.
- **Isolation.** Every card gets its own git worktree and branch; your checkout is never touched. (One exception: a repository with no commits at all gets an empty first commit, made without touching your files or index, because a branch needs a commit to start from.) Every stage is a fresh pi session that sees only the previous stage's artifacts (for example `plan.md`), never its conversation.
- **Gates.** A finished plan waits for you: approve it, or send it back with what should change.
- **Questions, not guesses.** When a decision is yours (what kind of app, which library), the agent stops and asks, with options you answer by clicking on the board. The same session then continues with your answers.
- **Your tests decide.** A project's verify command runs after each build; its exit code is the verdict. Failures go back to a fresh builder with the output, up to a cap, then the card asks for you.
- **Reviews before you look.** Once tests pass, review flows run in fresh sessions that never saw the builder's work: an adversarial review that tries to break the change, and a SOLID design review. Their findings are waiting at the feedback gate.
- **Pull requests, watched.** Approve the work and Tower pushes the branch and opens the pull request with `gh`. Failing CI goes to a builder with the failing checks (twice at most), a merge finishes the card and removes its worktree. A repository with no remote simply finishes with the branch ready to merge.
- **Run anything on a card.** A review flow, any pi skill, one of your `~/.pi/agent/agents` roles, or a plain prompt with the model you choose.
- **Live and steerable.** Every session streams to the board. Steer it mid-run, abort it, read its diff. Every session a card has had stays reachable from the rail above its transcript.
- **Survives restarts.** The queue is persisted; sessions interrupted by a restart resume in the same pi session.

Status: all six milestones are built. Everything is covered by tests that run the whole daemon, and the plan, build, test and question flows have been run against real pi sessions. The pull request stage is tested against a fake `gh` and a local remote, and has not yet been run against a real GitHub repository. See the [design](docs/superpowers/specs/2026-09-21-tower-design.md).

## Install as a pi package

Requires [pi](https://pi.dev), git, npm and **Node 22.18 or newer** (the daemon runs its TypeScript directly).

```sh
pi install git:github.com/rahult/tower
```

pi clones the repository to `~/.pi/agent/git/github.com/rahult/tower` and installs its dependencies. That adds one command, `/tower`, to every pi session. To try it without installing: `pi -e git:github.com/rahult/tower`.

> pi packages run with full access to your machine, and Tower runs coding agents that execute shell commands in your repositories. Read the source first.

### Updating

Pull the new version, then restart the daemon — the restart is the update, and it is safe with cards mid-flight:

```sh
pi install git:github.com/rahult/tower   # refreshes the installed clone
```

then `/tower restart` from any pi session.

- Sessions caught mid-run come back as **interrupted**: **Resume** continues them in the same pi session with their history intact, and queued cards simply start. Open pull requests keep being watched.
- Database changes are small additive migrations, applied at startup and announced in the daemon log; projects, cards and runs are kept.
- If the daemon keeps running across the file update (the restart was skipped), a card that enters its next stage before the restart may fail once with a prompt error, because prompt templates are read from disk per run. Nothing is lost: the card asks for attention with that reason; restart the daemon and press **Retry**.

### Start using it

Start pi **from a shell that has your provider API keys** (`ZAI_API_KEY`, `DEEPSEEK_API_KEY`, and so on). The daemon inherits that environment, and the sessions it spawns inherit it from the daemon. Providers you logged into with pi's `/login` work as usual.

```text
/tower
```

The first run builds the board UI (a few seconds), starts the daemon in the background and opens <http://127.0.0.1:4700>. The daemon keeps running after you quit pi.

| Command | What it does |
|---|---|
| `/tower` | Start the daemon if needed and open the board |
| `/tower start` | Start the daemon if needed, without opening a browser |
| `/tower open` | Open the board in the browser (starts the daemon if needed) |
| `/tower stop` | Stop the daemon. Sessions that were running can be resumed from the board next time |
| `/tower restart` | Stop and start again — how you pick up an updated install |
| `/tower add <title>` | Add a card for the current repository to its backlog. The repository becomes a project the first time |
| `/tower run <title>` | Add a card and start it: planning begins when a slot is free |
| `/tower status` | What is running, and what is waiting for you |
| `/tower settings` | Show which model runs each stage |
| `/tower settings planning=zai/glm-5.3 building=zai/glm-5.3-flash:low` | Set them. `:thinking` is optional; `stage=default` clears one |

A first card, end to end:

1. In a pi session inside one of your repositories: `/tower run Add retry with backoff to the HTTP client`.
2. On the board, open the project's **Settings** and set a **verify command** (for example `pnpm test && pnpm typecheck`) and, if a fresh checkout needs it, a **setup command** (for example `pnpm install --prefer-offline`). Without a verify command an agent judges the build instead of your tests.
3. The card plans, then turns amber: **Review**. Read the plan; approve it, or send it back with a note.
4. A cheap model builds from the plan in the card's worktree and commits on branch `tower/<id>-<title>`. Your verify command runs. If it fails, a fresh builder gets the output and tries again (three builds by default).
5. Reviews run, then the card turns amber again: **Review work**. Read the findings and the diff; approve, or send it back ("Ask it to fix the findings" writes the note for you).
6. Tower opens the pull request and watches it. When you merge it on GitHub, the card moves to Done.
7. Open the card any time to watch the session, **steer** it ("use the existing logger"), abort it, or read its diff under **Changes**.

Click a strip to open its card. Colour is state, and means the same everywhere: blue is an agent working, solid amber needs you, green is clear, red is a warning. Plans, replies and files are rendered (Markdown, highlighted code, pretty-printed JSON). The theme follows your system; the top bar has a toggle.

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
pnpm start          # daemon and board on http://127.0.0.1:4700
```

`pnpm start` builds the board UI first when it is missing or older than the web sources — the built `dist` is gitignored, so it never arrives with `git pull` or `pi update`. Run `pnpm build` ahead of time if you would rather not wait at startup.

## Configuration

Environment variables, read when the daemon starts:

| Variable | Default | Purpose |
|---|---|---|
| `TOWER_HOME` | `~/.tower` | Database, card folders (`cards/<id>/`), worktrees, `daemon.log` |
| `TOWER_PORT` | `4700` | Port. The daemon only ever binds `127.0.0.1`; there is no authentication |
| `TOWER_MAX_CONCURRENT` | `3` | Sessions and verify commands running at once, across all projects |
| `TOWER_MAX_BUILD_ATTEMPTS` | `3` | Builds per card before a failing test stops the loop |
| `TOWER_SUBAGENTS` | on | Whether plans may fan out to scouts and parallel stream builders. `0` turns it off everywhere |
| `TOWER_MAX_CREW` | `3` | How many of a card's scouts or stream builders run at once |
| `TOWER_REVIEW_FLOWS` | `adversarial-review,solid-review` | Review flows a project runs unless its Settings say otherwise. Empty turns them off |
| `TOWER_MAX_CI_FIX_ATTEMPTS` | `2` | Times a failing pull request is repaired before the card asks for you |
| `TOWER_PR_POLL_MS` | `120000` | How often open pull requests are checked |

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

Per project, under **Settings** on its lane: the verify command, the setup command, which review flows run, whether sub-agent crews may fan out, and how many of its cards may run at once (default 1).

Per card, models can be overridden when creating it through the API:

```sh
curl -X POST http://127.0.0.1:4700/api/cards -H 'content-type: application/json' -d '{
  "projectId": "<id>", "title": "Add a farewell function",
  "stageConfig": { "planning": { "model": "zai/glm-5.3", "thinking": "low" } }
}'
```

Stage defaults are in `packages/core/src/stage-spec.ts`.

### Flows: your own agents, deterministic or not

A flow is a JSON file: shipped ones are in `flows/`, yours go in `~/.tower/flows/` (same name overrides). Each step is a prompt file, a pi skill, one of your agent roles — or a shell command, which makes the step deterministic: no model, no spend, the exit code is the verdict.

```json
{
  "name": "ship-gate",
  "title": "Ship gate",
  "description": "The checks a build must pass before it is worth testing.",
  "when": ["after-build"],
  "steps": [
    { "name": "lint", "run": "pnpm lint", "timeoutSec": 120 },
    { "name": "size", "run": "pnpm size --strict", "expect": "note" },
    { "name": "security", "skill": "security-review", "model": "planning", "access": "read-and-run" }
  ]
}
```

- `run` executes in the card's worktree. `{{worktreePath}}`, `{{repoPath}}`, `{{branchName}}`, `{{cardDir}}` and `{{title}}` are substituted. A non-zero exit fails the flow unless `expect` is `"note"` — an informational step records its output and never blocks. Output streams into the run's transcript like the verify command does.
- `when` says when the flow runs. `manual` (the default) puts it in every card's Run tab. `after-plan` runs it between a passing plan and the plan gate; `after-build` between a passing build and testing; `after-tests` makes it one of the post-test reviews (the shipped adversarial and SOLID reviews declare this — with no `TOWER_REVIEW_FLOWS` set, every `after-tests` flow runs, in file order).
- A triggered flow that does not pass stops the card at `needs_attention` with the failing step's own words. Retrying from a failed after-build gate sends the gate's output back to the builder as feedback — the loop closes deterministically, without an opinion in sight.
- `model` is a stage name (`planning` means whatever plans for you) or an explicit `provider/model`. `access` is `read-only`, `read-and-run` or `write`. Pull requests need the [`gh` CLI](https://cli.github.com) logged in.

### Deep research

Not every line of work starts with a task; some start with a question. The shipped `deep-research` flow runs in two steps — a **survey** that maps the question and fetches evidence over the network (docs, the GitHub API, package registries, RFCs — via `curl`), and a **synthesize** step that writes a cited brief: options with trade-offs, a recommendation, what it means for *this* repository, and the open questions. The brief lands in the card's `reviews/` folder.

Research belongs before the lifecycle: the flow is read-only, so it runs on a **backlog card with no worktree**, straight in the project checkout — start it from the card's Run tab, or type an exploring line into the ⌘K box ("research local-first sync @remembero") and the intent reader files the card and starts the research. When a brief exists, the planner is pointed at it, so the research flows into the plan without a copy-paste. Flows that run commands or write code still need a worktree and are refused on backlog cards.

### Sub-agent crews

When a plan genuinely decomposes, the planner may append two optional sections to it, and Tower fans the build out to parallel sub-agents:

- **`## Scouts`** — read-only researchers who answer one question each before building starts, in parallel. Their reports land in the card's `research/` folder and the builders are told to read them.
- **`## Streams`** — independent workstreams. Each is built by its own agent in its **own worktree** (branch `tower/<card>-ws-<slug>`, dependencies installed once, reused across attempts), and an **integrator** agent then merges the branches into the card's branch, resolves conflicts and fixes the seams before testing runs.

The whole crew is one building attempt: the card's lifecycle, retries and gates work exactly as with a single builder. Scouts are advisory (a scout that fails costs nothing but a missing report); a blocked builder or integrator stops the card for your answers, and a retry re-runs the crew with your note in every member's instructions. Most plans should have neither section — the planner is told to split only when streams are truly independent, and the crew section of the planning prompt is written only when sub-agents are on.

Sub-agents are on by default and can be set per project (Tower default / on / off) under **Settings → Parallel sub-agents**. Every member session shows up in the card's drawer as its own run (`scout <slug>`, `builder <slug>`, `integrator`), and their tokens are part of the card's spend.

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
