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
- **Margin notes**: select text on the plan, a review or any card file and pin a note. Notes
  are stored on the card (`annotations.json` + rendered `annotations.md`), highlighted inline,
  and ride back to the agents two ways — a gate rejection always carries the open notes (a
  rejection can be notes alone), and open notes enter every stage prompt until resolved.
- **Plan to backlog**: a work-breakdown session (planning tier, tool-less) cuts a plan —
  pasted text or an existing card's `plan.md` — into proposed backlog cards with self-contained
  briefs. The draft returns as a checklist; filing lands the picked cards as inert backlog
  cards in the plan's order, so a spec can become a night's queue.

## P3 — Verification depth [shipped 2026-09-26]

- **Plan-gate coach** [shipped 2026-09-25, first slice]: `plan-coach` — a manual, read-only
  rubric pass over a draft plan at the plan gate (behavior, contract, data, failure modes,
  test targets, verification, edges, security, rollback, honesty). Its findings land beside
  approve/reject as advice a person pins as margin notes or ignores; the verdict never gates.
- **Invariant simulation as an after-build hook**: copy `invariant-simulation.flow.json`
  into `~/.tower/flows/` with `"when": ["after-build"]` to gate testing on it. The cheaper
  second pass ships too: `invariant-diff.flow.json` checks the *diff* against the
  invariants the plan already named (test tier) instead of re-deriving the model.
- **Review fan-out** [shipped 2026-09-25]: `parallelReviews` runs the after-tests reviews at
  the same time — reviewers who never see each other gain nothing from an order anyway.
- **Verification budget** [shipped 2026-09-25]: `budgetUsd` per project meters each card's
  spend while it runs; the pipeline opens a budget gate at the line.
- **Flaky-test memory** [shipped 2026-09-25]: the same failing signature twice stops the
  loop with the history attached instead of rebuilding blindly.

## P4 — Research harness depth [shipped 2026-09-26]

- **The Research lane** [shipped]: a question asked on the `#research` view needs no project.
  A survey gathers evidence over the network, a synthesizer writes the cited brief, and
  promotion — the person's decision — files the brief as a card in the project they pick,
  where the planner reads it like any research brief.
- **Live probes** [shipped]: a flow step with `"access": "probe"` gets full tools working in
  a throwaway probe directory (the card's `<cardDir>/probe`), so spike code can settle what
  the docs cannot — nothing in the worktree is touched, and backlog cards can probe too.
  The research lane's survey probes the same way.
- **Source trays** [shipped]: `sources` on a project (paths or URLs, edited in the project
  settings) render into research prompts as a pinned tray the survey must read first.
- **Scheduled deterministic agents** [shipped 2026-09-25]: `when: ["schedule"]` +
  `intervalHours` — a flow fires itself on a carrier card, on an interval.

## P5 — Work shaping [shipped 2026-09-26]

- **Stacked cards** [shipped 2026-09-25]: a card whose `baseCardId` is another card's branch
  builds on unmerged work; when the base lands first, the stack merges cleanly after.
- **Card dependencies** [shipped]: `dependsOn` on a card (set at creation from Add work) —
  the scheduler holds the dependent's queue place until the dependency lands; deleting the
  dependency releases it, never strands it.
- **Archive/delete** [shipped 2026-09-25]: finished and backlog cards delete from the board;
  deleting also clears dependents' waits.

## P6 — Product surface

- **Usage accounting for assist sessions** [shipped 2026-09-25]: card-less sessions (ask
  box, command drafts, model checks, research questions) are counted in Usage.
- **Mobile pass-through review** [shipped]: the board payload carries the pending gates and
  the `#review` view answers them — one tap to approve, a written note to send back. The
  nav entry appears only when a decision waits.
- **Multi-board**: one daemon, several boards by project set.

## Non-goals

- No model-side trust of agent verdicts: a deterministic gate can only be satisfied by a
  command exit code; an agentic verdict is always labeled as one.
- No code execution from research steps against anything but the card's worktree or the
  read-only checkout.
