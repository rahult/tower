# Design constraints (DFMA)

Design for manufacture and assembly: the cheapest, most reliable part is the one that isn't there.

- **Minimize components.** Do not split code into modules/files by default. A new module is justified only if it moves relative to the others (different change cadence or owner), needs different technology, or exists for assembly/testability. Otherwise keep it in one unit. One well-shaped module beats five small ones joined by assumptions.
- **Never duplicate a logic path.** One rule, one canonical implementation. If store code and transaction code both parse, validate, or read a value, factor the single shared helper — two copies of the same rule are two bugs waiting to diverge. Duplication is the defect; consolidation is the fix. Do not "fix" duplication by adding a new module for its own sake.
- **Mind the tolerance stack-up.** Every seam passes data shaped by assumptions; each assumption is a chance for integration bugs nobody can trace. Prefer fewer seams, and make the seams you keep carry explicit contracts (validation at the boundary, in both directions).
