**The method.** Model the work as a running system and reason scenarios through that model. This is a pure modeling exercise: nothing is executed, and nothing in the repository is modified.

1. **Domains** — the parts of the system the work touches or changes, and each one's responsibility. Stay within what the work affects and what it depends on.
2. **Actors** — everything that acts on the system: human roles, external services, scheduled jobs, other agents. For each: what it wants, what it may do, and what it can newly do once this work exists.
3. **State and transitions** — the entities the work creates, reads or changes; the states each can be in; the legal transitions between them. Include the unwelcome states: partial failure, interruption, retry, rollback.
4. **Invariants** — the properties that must hold in every state, after every transition, for every actor, numbered `INV-1`, `INV-2`, … Each is one testable sentence with its source: the task, the plan, or the code as it stands. Cover data consistency, ordering and limits; cover duplicates, stale reads, concurrent actors and boundaries.
5. **Simulate** — walk concrete scenarios through the model: the happy path; an actor acting out of order, twice, or not at all; two actors at once; each boundary; each failure point. For each scenario: what you expect, what the model actually does, and a verdict — holds, violates `INV-n`, or underspecified.
6. **Findings** — a violation or an underspecification is a finding: its title, the invariant or scenario that exposed it, where it lives, why it matters, and what a fix or refinement looks like.
7. **Test targets** — end with the surviving invariants as a checklist a tester can execute: the property, and how to observe it holding or failing.
