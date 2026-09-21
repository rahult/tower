---
target: Tower board UI (packages/web)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-09-21T21-18-50Z
slug: packages-web-src-app-tsx
---
# Impeccable Critique — Tower board UI (packages/web)

Target: packages/web/src/App.tsx (the Tower web board; live demo at 127.0.0.1:4720). Method: dual-agent.

## Design Health Score: 29/40 (Good)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Excellent: connection badge, per-run chips, live elapsed timers, sweep bars, tab-title count, hidden-tab notifications. |
| 2 | Match System / Real World | 3 | Mostly crisp dev language; internal terms leak: run chips like "planning 2×", "Feedback" stage label collides with reviewer feedback, "pi skill" assumes pi fluency. |
| 3 | User Control and Freedom | 2 | Abort and Remove-from-queue are single-click, irreversible, no undo/confirm; Escape closes modals but not the drawer. |
| 4 | Consistency and Standards | 3 | Strong token/button system; drawer tabs are aria-pressed buttons, not tablist semantics; two different approve controls for the same gate (row vs GatePanel). |
| 5 | Error Prevention | 3 | Send-back requires a written note (excellent); "Approve & open PR" and Abort are unguarded instant actions; disabled buttons carry reasons. |
| 6 | Recognition Rather Than Recall | 3 | Context lines and inline questions are recognition-strong; Models and Run panels demand typed provider/model and pi-skill strings from memory. |
| 7 | Flexibility and Efficiency | 3 | ⌘K palette, ⌘1–4, n, ⌘Enter steer; no keyboard navigation of card rows, no per-project filter on Focus. |
| 8 | Aesthetic and Minimalist Design | 4 | Restrained and purposeful; in-flight rows quiet by design; zero decorative noise. |
| 9 | Error Recovery | 2 | Mutation failures surface raw error.message; no retry affordance; "Abandoned" cards are a dead end (no actions). |
| 10 | Help and Documentation | 2 | Help lives in hover title attributes (invisible to touch/keyboard/SR); empty states are the one well-done help surface. |

All ten heuristics scored; maximum 40.

## Design Specificity Verdict

Genuinely authored for Tower, not category-interchangeable admin UI. The annunciator system is enforced in code (a Tone type feeding BAR_CLASS/CHIP_CLASS maps; "only a card that needs you is filled solid"), the Focus view is a real prioritization philosophy (decisions rendered in place, in the row), and the copy has a voice ("A cheap model will build from this plan alone, so it has to stand on its own."). The flight-deck identity rests on behavioral discipline more than ornament, and that discipline is undermined in one important place: the dark theme breaks the amber signal itself (contrast 1.2–1.24:1 for caution-ink text on dark surfaces).

## Cognitive Load

- Failures: "one decision at a time" (multi-question forms can coexist across several amber rows); RunsRail dot colors have no legend (must be remembered).
- Decision points >4 visible options: top-bar right cluster (6 controls), drawer tabs (5), QuestionsPanel when "Something else" is open, RunPanel kinds (exactly 4).
- Progressive disclosure and single-focus hierarchy are genuinely good.

## Emotional Journey

Peak ("All clear.") and end (green "Finished today" tray) are designed and land. Failure states read well in words but not in recovery: an Abort click flips state with no acknowledgment, no undo toast, no "what now"; "Abandoned" strands the user. High-stakes moments are verbally reassuring but physically frictionless — the most consequential click (Approve & open PR) is the least guarded. No toast layer exists between click and state change.

## Strengths

1. The annunciator discipline is architectural, not painted on — Tone flows through typed maps, so color means the same thing in strip, chip, tray dot, and drawer bar.
2. Decision-in-place rows render the actual QuestionsPanel inside the tray row and summarize gate stakes in one sentence — the product thesis made tangible.
3. Copy as interface: nearly every microcopy line explains a consequence, not a feature.

## Priority Issues

1. [P1] Dark mode makes the "needs you" signal unreadable — --caution-ink (#2a1e00) is used both as text-on-amber and amber-text-on-dark (measured 1.2–1.24:1). Affected: lane header "N need you", Projects chips, Plan approval/Review work chips on Focus rows, onCaution button (near-black borderless shape on dark sheet). Fix: per-theme --caution-ink (dark ~#ffd75e), border on onCaution, darken light --ok to ~#146b40.
2. [P1] Destructive actions are single-click and irreversible — Abort (Focus rows, Drawer header, Board strips) and queue Remove fire immediately; no undo anywhere; in the Drawer, Abort sits directly beside Close. Fix: two-step arm ("Abort" → "Confirm abort?" ~3s) or toast with Undo; separate Abort from Close spatially.
3. [P2] The drawer behaves like a passive pane — no focus move or announcement on open, Escape doesn't close it, tabs are aria-pressed buttons without tablist/tab/tabpanel roles or arrow-key switching, and the auto-switch to Decision is silent (no aria-live anywhere). Fix: real tab semantics, focus the heading on open, Escape closes, one polite live region for "N cards need you".
4. [P2] Errors surface raw and dead-end — mutations render error.message verbatim; no retry; "Abandoned" status shows a red chip and zero actions. Fix: map failures to human copy + inline Retry; give Abandoned an explicit path.
5. [P2] Recall-heavy power panels — Models and Run panels require typed provider/model and pi skill/agent names from memory; no inline validation against knownModels. Fix: validate with warnings; list available skills/agents.
6. [P3] The board scrolls horizontally at every realistic width (min ≈ 107rem); Done toggle reads a bare number when expanded; Focus's "see the board" link lands where Done is folded away. Fix: responsive collapse of middle stages under ~1400px; copy fixes.

## Persona Red Flags

- Alex (impatient power user): no keyboard path to the first amber row (no j/k row nav); board always horizontally scrolled even at 1600×1000; theme button cycles through states with a label that shows the current state ("Dark" click means "go auto"); one stray click on Abort kills a session with no undo.
- Sam (keyboard / screen reader): drawer tabs are pressed-buttons, not tabs; drawer never receives focus or an announcement; no live region, so a card turning amber is invisible (only the hidden-tab notification covers it); hover-only title help is unreachable; palette listbox has no aria-activedescendant.
- Priya (fleet operator, 12 repos, 10 agents): Focus trays have no caps or filters — 10 gates means 10 amber rows, each potentially 26rem of inline questions; needs-you ordering ignores the existing priority field; header shows only a total count, not per-project waiting. At her scale the "one attention queue" premise collapses.

## Minor Observations

- No loading state for the initial board fetch (empty paper page until first data).
- DoneRow "finished 42s ago" freezes (no ticker), unlike FlightRow's live elapsed.
- Palette lists the same title twice (Cards + "Start a backlog card" groups).
- Board Done toggle shows a bare count when expanded.
- The subtle border/bg distinction between full and half-faded attention rows is likely lost.
- Long titles: clamped on strips (no tooltip), wrapped on Focus rows — inconsistent but defensible.
- Reduced-motion, tabular numerals, and h-dvh handled correctly.

## Questions to Consider

1. If you stripped amber/blue/green/red tomorrow, would this UI still communicate state from across the room — or is the annunciator doing work the layout should? (Grayscale test it.)
2. Why is the most consequential click — "Approve & open PR" — the least guarded interaction, while the reversible one (send back) demands a written justification?
3. Focus answers "what needs me now," but nothing answers "how is my fleet doing" — no per-project roll-up, no priority ordering, no weekly arc. Is Tower a flight deck for one controller, or a control tower for an airport?

## Deterministic Scan

Exit code 2; 1 finding: styles.css:282 side-tab (prose blockquote border-left). Judged false positive — a neutral hairline rule on rendered Markdown blockquotes (the only border-left in the tree), not a decorative card accent. No real detector findings; the mechanical slop checks pass. Browser overlay injection unavailable in this session's subagents ("Browser is not available in subagent"); CLI scan stands as fallback evidence.
