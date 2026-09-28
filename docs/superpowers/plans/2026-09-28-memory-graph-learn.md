# Plan: memory graph Phase 2 — the learn step (write path)

**Spec:** `docs/superpowers/specs/2026-09-28-project-memory-graph.md` (Phase 2)
**Branch:** `feature/project-memory-graph`
**Date:** 2026-09-28

## What this adds

The write path that closes the learning loop: when a card finishes, what it learned
(gotchas, failure modes, coupling, invariants the code actually enforces) is proposed as
structured changes to the project memory graph. Proposals land as **pending**; a human
confirms each one (v1 is human-confirm only, per the spec's non-goals). Accepting applies
the change to the graph with fresh provenance and re-renders `system-model.md`.

## Shape of a proposal

The builder agent writes `learn.json` beside `shipped.md` — a structured diff, not prose:

```json
{
  "proposals": [
    { "action": "add_node", "kind": "gotcha", "name": "Empty titles pass validation",
      "summary": "…", "source": "src/app.ts:42", "evidence": "test output or file:line" },
    { "action": "update_node", "kind": "invariant", "name": "INV-1", "summary": "…", "evidence": "…" },
    { "action": "retire_node", "kind": "gotcha", "name": "…", "evidence": "…" },
    { "action": "add_edge", "edgeKind": "depends_on", "from": "domain:api", "to": "domain:storage", "evidence": "…" },
    { "action": "retire_edge", "edgeKind": "depends_on", "from": "…", "to": "…", "evidence": "…" }
  ]
}
```

Every proposal names the node/edge, the action, and the evidence. Junk entries are skipped
at parse time, never stored — a corrupt file cannot poison the graph.

## Pieces

1. **Core** (`packages/core/src/memory-proposals.ts`)
   - `GraphProposal` type: id (`prop-<cardId>-<n>`), projectId, cardId, action, node/edge
     payload, evidence, status (`pending|accepted|rejected`), timestamps.
   - `parseLearnReport(raw, ctx)` → validated proposals with normalized ids (same slug rule
     as `seedFromMarkdown`, so learned nodes dedupe against seeded ones).
   - `applyProposal(graph, proposal)` → `{ graph, applied, reason? }`, pure:
     - `add_node` — skip if the id already exists.
     - `update_node` — merge summary/source, bump confidence +0.15 (cap 1), fresh provenance.
     - `retire_node` — remove the node and its incident edges.
     - `add_edge` — both endpoints must exist; skip duplicates.
     - `retire_edge` — remove the matching (kind, from, to) edge.
   - New nodes start at confidence 0.6, provenance = the finishing card + commit.

2. **Daemon store** (`packages/daemon/src/memory-proposals.ts`)
   - `memory-proposals.json` beside `memory-graph.json` (same atomic temp+rename write,
     same "greppable and diffable" rationale as the graph).
   - `learnFromCard({config, card})` — read `<cardDir>/learn.json`, parse, filter against the
     graph (skip adds that already exist), append pending proposals. Best-effort: a missing
     or malformed file is a no-op, never an error — the card has already finished.
   - `decideProposal(config, projectId, proposalId, decision)` — on accept, apply to the
     graph, write it, and re-render `system-model.md` (the projection stays derived); mark
     the proposal decided either way.

3. **Hook** (`packages/daemon/src/orchestrator.ts`)
   - In `dispatch()`, the `next.stage === "done"` branch runs `learnFromCard` after the
     state lands. Fires for every finish line (local merge, PR merge, PR skip). Failures
     log and swallow; learning must never block a card.

4. **HTTP** (`packages/daemon/src/http/server.ts`)
   - `GET /api/projects/:id/proposals` → `{ proposals, graph: { nodes, edges } }`.
   - `POST /api/projects/:id/proposals/:pid/decide` body `{decision: "accept"|"reject"}`.
   - Both publish `proposals_updated` on the board topic so SSE clients refetch.

5. **Builder prompt** (`prompts/building.md` + `stage-runner.ts`)
   - A "What you learned" section: the `learn.json` contract, when to write it (only what the
     next card benefits from), and "skip rather than guess". New `{{learnPath}}` var.

6. **Web** (`packages/web/src/projects/ProjectSettings.tsx`)
   - A Memory section under the system model: graph node/edge counts, pending proposals
     with action + name + evidence, Accept/Reject buttons. Polls like the model query.

## Testing

- **Core unit tests** (`packages/core/test/memory-proposals.test.ts`): parse validation,
  per-action apply, dedupe, confidence bump, retire cascades to edges, file validation.
- **Daemon integration** (`packages/daemon/test/memory-learn.test.ts`): the harness repo is
  a small **todo app** (in-memory store, add/toggle/delete, an invariant). Understand →
  graph seeded; a card finishes with a scripted builder writing `learn.json` (a gotcha, a
  `depends_on` edge, an invariant update); assert proposals land pending via the API;
  accept/reject drive the graph and the re-rendered `system-model.md`; a daemon restart
  keeps decided proposals; malformed `learn.json` never blocks `done`.
- `pnpm typecheck` + `pnpm test` green.

## Out of scope (later phases, per spec)

- Agent autonomy (low-risk auto-commit) — v2 behind a flag, after trust is earned.
- Memory view UI with filtering/drill-down (Phase 3); cooling/stale surfacing (Phase 4).
- Review-stage proposals (v1 learns from the builder's artifacts only).
