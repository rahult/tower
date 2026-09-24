# Tower roadmap — the harness a developer and a researcher both want

What Tower is today: a board that turns units of work into cards (or ideas into scaffolded
projects), plans them with a strong model grounded in a per-project system model, builds them
(optionally with a parallel crew in own worktrees), verifies with deterministic commands and
acceptance gates, reviews with adversarial flows, and finishes as a pull request or a local
merge. The pillars below are ordered by how much leverage they add per unit of build cost.
Items marked **[shipped]** landed; the rest is the committed backlog.

## The four pillars

1. **Agents you design yourself — deterministic or agentic, run when required.**
   Verifiable software needs gates whose verdicts don't depend on a model's opinion, and
   exploratory work needs open-ended agent sessions. The same flow pipeline should express
   both, and the lifecycle should know when to run each.
2. **Research for the "I don't know" space.** Most expensive mistakes happen before the
   plan: the wrong library, the wrong shape, the wrong problem. Tower should let a software
   explorer ask a question, get a cited brief, and only then commit to a card.
3. **Quality close to a human expert.** Staged verification: deterministic checks, then
   adversarial review, then human gates at the moments that matter — with evidence attached
   to every verdict.
4. **The harness carries the practices, so the person only carries the idea.** Good software
   comes from method — model the system, derive invariants, test first, verify what matters —
   and method can be encoded: in archetypes that scaffold new projects, in a system model that
   explains existing ones, and in gates that make the discipline non-optional.

## P0 — Composable agents: deterministic steps + lifecycle triggers [shipped 2026-09-24]

Flows are the unit of "design your own agent". Until now every step was a model session and
flows ran only on demand or as post-test reviews.

- **Deterministic steps**: a step with `"run": "<shell command>"` executes a command in the
  card's worktree — no model, no spend, the exit code is the verdict. Output streams to the
  run's transcript; `expect: "note"` makes a step informational (fails never), the default
  `expect: "pass"` makes it a gate. Template variables: `{{worktreePath}}`, `{{repoPath}}`,
  `{{branchName}}`, `{{cardDir}}`, `{{title}}`.
- **Triggers**: a flow declares `"when": ["manual", "after-plan", "after-build",
  "after-tests"]`. Manual is the default. `after-plan` flows run between a passing plan and
  the plan gate/building; `after-build` flows run between a passing build and testing;
  `after-tests` replaces the fixed review-flow list — any flow with that trigger joins the
  post-test reviews (a project's own `reviewFlows` and the `TOWER_REVIEW_FLOWS` override
  still win).
- **Gate semantics**: a triggered flow that does not pass stops the card at
  `needs_attention` with the failing step's summary. Retrying from a failed after-build
  gate sends the gate output back to **building** as feedback — the loop closes
  deterministically.
- **Roles compose**: steps can still be `prompt`, `skill`, or `agent` (a
  `~/.pi/agent/agents/<name>.md` role file with its own model/thinking/tools), so one flow
  can be e.g. a lint gate → an agentic critique → a deterministic size check.

## P1 — Deep research before commitment [shipped 2026-09-24]

- **`deep-research` flow** (shipped, manual): two agentic steps — a *survey* that maps the
  question and fetches evidence over HTTP (docs, GitHub API, package registries, RFCs via
  `curl`), and a *synthesize* step that writes a cited brief: what the question really is,
  options with trade-offs, a recommendation, what it means for **this** repository, and
  open questions. Reports land in the card's `reviews/` folder.
- **Research on backlog cards**: read-only flows run on a card with no worktree, straight
  in the project checkout — explore *before* the lifecycle starts. Write-access flows and
  deterministic commands still require a worktree.
- **The planner reads the brief**: when a deep-research brief exists on the card, the
  planning prompt points the planner at it, so research flows into the plan without a
  copy-paste.
- **Ask box**: `⌘K` lines that read as exploration ("research how to…", "what's the best…")
  become a `research_card` — the card is filed and the deep-research flow starts on it.

## P2 — From an idea, and into existing systems [shipped 2026-09-24]

The OpenRig-inspired slice: a harness where "create a todo app" produces senior-grade work,
and where existing repositories are understood before they are changed.

- **Archetypes**: `archetypes/web-app/` is a versioned engineering baseline — Vite + React
  frontend, zero-dependency Node (`node:http` + `node:sqlite`) backend, vitest, an acceptance
  runner, and a conventions README. The scaffold owns the practices so the first card plans
  the app, not the toolchain. `GET /api/archetypes` lists what is installed.
- **From idea to project**: `POST /api/projects/from-idea` (and a "New from idea" dialog on
  the Projects wall) scaffolds the archetype into `<home>/repos/<slug>`, registers the project
  with the manifest's commands, files the idea as the first card, and starts planning. The ask
  box classifies build-from-scratch lines (`"create a todo app"`) as `new_project` — it works
  on an empty board. From-idea projects are born with acceptance gates on when the archetype
  declares `"acceptance": true`.
- **The system model (brownfield)**: the `understand-system` flow runs a read-only pass over
  a checkout and writes the project's model — domains, actors, state, invariants as built
  with code sources, risks. `POST /api/projects/:id/understand` runs it on an inert carrier
  card and promotes the report to `<home>/projects/<id>/system-model.md`, stamped with the
  commit it describes; the editor shows fresh/stale/missing and a rebuild button. The
  `understandBeforePlan` toggle (project or `TOWER_UNDERSTAND_BEFORE_PLAN`) rebuilds a
  missing or stale model **before planning** — a new lifecycle hook phase, rerun by retry —
  and the planner reads the model in its prompt. The codebase wins where the model is stale.
- **Acceptance gates (TDD, enforced)**: the `acceptanceGates` toggle (project or
  `TOWER_ACCEPTANCE_GATES`) turns the lifecycle test-first. The planner must end its plan
  with `## Test targets`; the `acceptance-red` after-plan flow turns them into failing specs
  and a deterministic gate proves they are red (`npm run accept -- --expect-red` — a spec
  that already passes fails the gate); the builder inherits the specs as a contract it may
  not weaken; the `acceptance-green` after-build gate only lets a build move on when every
  spec passes. An empty harness never counts as a pass.

## P3 — Verification depth (next)

- **Promote invariant simulation to an after-build hook**: the modeling protocol already
  ships in planning/testing; with P0 a project can copy `invariant-simulation.flow.json`
  into `~/.tower/flows/` with `"when": ["after-build"]` to gate testing on it. Remaining
  work: a cheaper second-pass simulation prompt that checks the *diff* against the plan's
  model rather than re-deriving it.
- **Review fan-out**: crews exist for building; feedback flows should also run in parallel
  when a project opts in.
- **Verification budget**: a per-card ceiling on agent spend before the human is asked,
  surfaced in the drawer next to attempt counts.
- **Flaky-test memory**: a run of the same failing signature N times files a card with the
  history attached instead of rebuilding blindly.

## P4 — Research harness depth

- **Deep research on the board, not just the card**: a Research lane where a question
  doesn't need a project yet; promoting a brief to a card picks the project then.
- **Live probes**: run spike code against candidate libraries inside a throwaway worktree
  as part of a research step (today research is read-only + HTTP).
- **Source trays**: per-project pinned sources (internal docs, design docs, past briefs)
  that research steps are told to read first.
- **Scheduled deterministic agents**: `when: ["schedule"]` + an interval — nightly drift
  checks, dependency audits, cost reports as first-class flows.

## P5 — Work shaping

- **Stacked cards**: a card whose base is another card's branch (design note in
  `~/.zcode` project memory; plumbing exists — `ensureWorktree` takes a base branch).
- **Card dependencies**: explicit "after card X" scheduling beyond stacking.
- **Archive/delete**: board hygiene without database surgery.

## P6 — Product surface

- **Usage accounting for assist sessions** (today card-less sessions are invisible to
  Usage).
- **Mobile pass-through review**: the two gates (plan approval, feedback) are the whole
  human job; make them one-tap from a phone.
- **Multi-board**: one daemon, several boards by project set.

## Non-goals

- No model-side trust of agent verdicts: a deterministic gate can only be satisfied by a
  command exit code; an agentic verdict is always labeled as one.
- No code execution from research steps against anything but the card's worktree or the
  read-only checkout.
