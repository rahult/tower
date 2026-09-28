# Project memory graph — implementation plan

Companion to `docs/superpowers/specs/2026-09-28-project-memory-graph.md`.
Ordered so each step is reviewable on its own and leaves the tree buildable.

## Phase 1 — Schema, store, query, render (this branch)

Goal: a typed graph that can be read and projected, with zero behaviour change for
projects that have not opted in. Land behind the existing `understandBeforePlan`
flag so nothing flips on by default.

### 1.1 Types — `packages/core/src/memory-graph.ts` (new)

Export the node and edge discriminated unions, matching the spec:

- Node kinds: `domain | actor | flow | entity | invariant | gotcha | failure_mode`.
- Edge kinds: `acts_on | reads | writes | depends_on | enforces | has_gotcha | fails_at`.
- Shared fields on every node/edge: `id`, `kind`, `provenance: { cardId, commit, confidence, lastTouched }`.
- A top-level `MemoryGraph` type: `{ version, projectId, nodes, edges }`.
- A `GraphQuery` type: `{ seedNodeIds: string[], depth: number }` and a
  `Subgraph` result: `{ nodes, edges }`.

Keep it pure data — no I/O, no fs. Importable from both daemon and web.

### 1.2 Store — `packages/daemon/src/memory-graph.ts` (new)

Mirror `system-model.ts`:

- `paths.memoryGraph(config, projectId)` → `<home>/projects/<id>/memory-graph.json`.
- `readGraph(config, projectId): MemoryGraph | null` — returns null if missing or
  unparseable (never throws into the daemon).
- `writeGraph(config, projectId, graph)` — atomic write (write temp, rename) so a
  crash mid-write cannot corrupt the file.
- `emptyGraph(projectId): MemoryGraph` — versioned empty shell for first use.
- Version constant `MEMORY_GRAPH_VERSION = 1`; `readGraph` rejects unknown
  versions with a clear error rather than silently misreading.

### 1.3 Query — same file

- `relevantSubgraph(graph, query): Subgraph` — BFS from each seed, capped at
  `depth`, deduped. Pure function, unit-tested.
- `touch(graph, nodeIds, meta)` — bumps `lastTouched` on the given nodes. Pure.
- `markCooling(graph, untouchedForCards)` — returns node ids past the threshold.
  Pure; the threshold is a project setting defaulting to 10.

### 1.4 Render — `packages/daemon/src/memory-graph-render.ts` (new)

- `renderSystemModel(graph): string` — traverses nodes and edges and emits the
  Markdown the planner already expects, under the same headings the current
  `understand-system.md` prompt uses (Domains, Actors, State and transitions,
  Invariants, Risks and quirks, Open questions). Every claim carries its source
  from node provenance.
- This replaces the hand-authored `system-model.md` for opted-in projects: the
  file is still written to the same path so existing planner prompts need no
  change.

### 1.5 Seed from the existing model — `packages/daemon/src/memory-graph.ts`

- `seedFromMarkdown(markdown, projectId, meta): MemoryGraph` — best-effort parse
  of an existing `system-model.md` into nodes/edges. Imperfect by design: it
  captures domains, actors, invariants, and risks as nodes with a single
  `depends_on`/provenance edge each. The learn step (Phase 2) refines it.
  Confidence starts low (0.4) so the first real card pass raises it.
- Wire it into the understand flow's promote step: after `promoteSystemModel`,
  also `seedFromMarkdown` if no graph exists yet. Idempotent — a second run
  does not duplicate nodes (match by name + kind).

### 1.6 Planner integration — `packages/daemon/src/orchestrator.ts`

- When building the planning prompt, if the project has a graph, compute the
  seed set from the card's brief (match domain/actor/flow names mentioned) and
  append `relevantSubgraph` as a fenced block alongside the existing model.
  Fall back to the full rendered model when the brief names nothing.
- Bump `lastTouched` on the seeds the planner actually read (best-effort: the
  seeds we sent).

### 1.7 Tests

- `packages/daemon/src/memory-graph.test.ts`: read/write round-trip, atomicity
  under simulated crash, query depth capping, touch + cooling, seed idempotency,
  render produces the expected headings.
- `packages/core/src/memory-graph.test.ts`: type narrowing and validation of
  malformed input (unknown kind, missing provenance) — these must be rejected,
  not coerced.

### 1.8 Docs

- Update `README.md` Configuration table: document `TOWER_MEMORY_GRAPH` (on by
  default for new projects, off for existing until they run understand) and the
  per-project `memoryGraph: true|false` setting.
- One line in the system-model section noting the snapshot is now a generated
  projection of the graph.
- Link this plan from `docs/ROADMAP.md` under a new "P7 — Living project memory"
  section, marked in progress.

## Phase 2 — Learn step (separate PR)

- New flow `learn-from-card.flow.json`, trigger `after-tests`, prompt
  `learn-from-card.md`.
- The prompt receives the card's diff, test output, and the current subgraph;
  it returns a structured JSON diff: `{ adds: [...], updates: [...], retires: [...] }`
  validated against the schema before apply.
- Pending proposals stored at `<home>/projects/<id>/memory-proposals/<cardId>.json`;
  a small API + UI surface to confirm/reject. v1 is human-confirm only.
- On confirm, apply the diff, refresh provenance, re-render `system-model.md`.

## Phase 3 — Memory view (separate PR)

- New `Memory` view on the project, graph rendered with the existing web stack
  (no new dependency in v1 — a simple force layout or a table + edge list;
  evaluate a graph lib only if the table proves insufficient).
- Filter by node kind and by cooling/stale state; click-through to provenance
  and the cards that shaped each node.

## Phase 4 — Confidence & retirement (separate PR)

- Cooling/stale marking surfaced in the Memory view and injected into planner
  context as "unverified — confirm or drop."
- Auto-retirement: a card whose diff contradicts a node marks it stale rather
  than deleting it; stale nodes drop out of agent context after one more
  untouched cycle.
- Confidence scoring: each confirm raises it, each contradiction lowers it;
  nodes below a floor are hidden from agents until re-confirmed.

## Out of scope for all phases

- No general-purpose KB. No cross-project sharing. No autonomous writes in v1.
- No diagram export (Phase 3 candidate, not committed).
