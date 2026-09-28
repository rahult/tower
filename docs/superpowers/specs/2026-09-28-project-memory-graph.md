# Project-specific memory graph

**Status:** proposal — not yet implemented.
**Date:** 2026-09-28
**Author:** Rahul + Grok

## The problem

Tower already builds a per-project **system model** — domains, actors, state, invariants as built, stamped with the commit it describes. Every planner reads it. But it is a one-shot, read-only snapshot: it goes stale the moment the code moves, and it never absorbs what cards *learn* while they work. Gotchas, failure modes, coupling that only shows up under change, schema quirks — all of that evaporates when the card closes.

Docs go stale for the same reason: they are a copy someone has to remember to update. The fix is not better docs. It is making the knowledge the thing the work reads from and writes to.

## The idea

Replace the flat Markdown snapshot with a **living, project-scoped knowledge graph** that every card reads from before it starts and writes to when it finishes. The graph is the single source of truth; the human-readable doc and the agent context are both projections of it, generated on demand, so they can never drift from reality.

This kills three birds with one stone:

1. **Stale docs** — there are no docs to maintain; the rendered view is derived.
2. **Stale system model** — the graph is updated by the work itself, not by a separate rebuild pass.
3. **Lost learning** — every card's discoveries (gotchas, failure modes, coupling) become durable, queryable context for the next card.

## What the graph holds

Nodes, each typed:

- **Domain** — a bounded part of the system (e.g. `billing`, `auth`).
- **Actor** — anything that acts: a service, a human role, a scheduled job, another agent.
- **Flow** — a sequence of steps an actor takes through domains (e.g. `checkout → payment → receipt`).
- **Entity / schema** — a persisted thing and its shape (tables, files, caches, queues), including the DD schema where relevant.
- **Invariant** — a property the code enforces, numbered, with its source.
- **Gotcha** — a sharp edge discovered in practice: surprising coupling, a test that lies, a convention that bends itself.
- **Failure mode** — where and how things break, learned from a card that hit it.

Edges, each typed and directional:

- `ACTS_ON` — actor → domain / flow.
- `READS` / `WRITES` — flow → entity.
- `DEPENDS_ON` — domain → domain (the blast-radius edge: change X, impact Y).
- `ENFORCES` — invariant → entity / flow.
- `HAS_GOTCHA` — gotcha → the node it attaches to.
- `FAILS_AT` — failure mode → flow / entity.

Every node and edge carries provenance: which card discovered or last confirmed it, which commit, a confidence score, and a `lastTouched` timestamp.

## The lifecycle

```
card starts
   → planner pulls the relevant subgraph (nodes + edges within N hops of the
     card's touched domains/actors/flows) into its context
card works
   → builder / reviewer may flag discoveries mid-run (a gotcha, a new coupling)
card finishes (pass or fail)
   → a "learn" step diffs the card's artifacts against the graph and proposes
     additions and updates
   → proposals land as pending; a human confirms (v1) or the agent commits
     low-risk updates directly (v2, behind a flag)
   → confirmed updates rewrite the affected nodes/edges with fresh provenance
```

The learn step is the heart of it. It is not a free-form "write what you learned" — it is a structured diff: for each proposed change, name the node, the edge, the evidence (a file:line or a test output), and whether it is an add, an update, or a retirement. That structure is what keeps the graph honest.

## Freshness without a chore

Staleness is the failure mode that kills knowledge systems, so it is designed in, not bolted on:

- **Touch on use.** Reading a node during planning bumps its `lastTouched`. A node untouched for N cards (configurable, default 10) is marked `cooling`.
- **Retire on contradiction.** If a card's diff shows a node no longer matches the code, it is marked `stale` rather than silently kept — the codebase wins, same rule the current system model already follows.
- **No silent decay.** A `cooling` or `stale` node is surfaced in the project settings and in the planner's context as "unverified — confirm or drop," never trusted blindly.
- **The graph is the doc.** There is no separate documentation file to forget. `system-model.md` becomes a generated projection: traverse the graph, render nodes and edges as Markdown. It is always current because it is never authored by hand.

## The graph view

A new **Memory** view on the project (next to Settings) renders the graph: nodes as cards, edges as links, filterable by type and by "touched in last N cards." Clicking a node shows its provenance, its edges, and the cards that shaped it. This is the contextual map an agent — and a human — reads to answer "if I change this actor, what else breaks?"

For agents, the same data is exposed as a queryable subgraph rather than a rendered page: given a set of touched nodes, return the closure of dependent nodes with their confidence and provenance. That is what goes into the planner's and builder's context.

## Storage

The graph lives at `<home>/projects/<id>/memory-graph.json` (or `.sqlite` if the graph grows past a few thousand nodes — start with JSON, migrate when a project forces it). It sits beside the existing `system-model.md`, which becomes the generated projection. The schema is versioned so migrations are cheap.

Why not the main Tower database: the graph is project-scoped knowledge that should survive a Tower reinstall and be inspectable without the daemon. A plain file keeps it greppable and diffable.

## Phased delivery

**Phase 1 — Schema + read path (this PR's scope as a spec).**
Define the node/edge types, the JSON schema, the query that returns a relevant subgraph, and the generator that renders `system-model.md` from the graph. No UI yet. Ship behind the existing `understandBeforePlan` flag so projects opt in.

**Phase 2 — Write path.**
The post-card "learn" step: structured diff against the graph, pending proposals, human confirm. This is where the learning loop closes.

**Phase 3 — The view.**
The Memory view on the project, filterable, with provenance drill-down. This is the payoff for humans; agents already benefit from Phase 2.

**Phase 4 — Confidence & retirement.**
Cooling/stale marking, auto-retirement on contradiction, the "unverified" surfacing in planner context.

## Non-goals

- Not a general-purpose knowledge base. It is scoped to one project's codebase and the work done on it.
- Not a replacement for the codebase. The graph describes the system; the code is the source of truth, and the graph defers to it on conflict.
- Not autonomous in v1. Agents propose, humans confirm. Autonomy comes only after the graph has earned trust through a run of confirmed updates.

## Open questions

1. **Granularity of "relevant subgraph."** N hops is a starting heuristic; the right depth probably depends on the card's blast radius, which the plan itself should declare.
2. **Where the learn step runs.** After-build (catches builder discoveries) or after-tests (catches review discoveries too)? Likely both, with after-tests being the richer pass.
3. **Conflict resolution when two cards touch the same node concurrently.** Last-write-wins with provenance is fine for v1; a merge of proposals may be needed later.
4. **Export.** Should the graph be exportable (e.g. to a diagram tool) for humans who think visually? Probably yes, but not in Phase 1.
