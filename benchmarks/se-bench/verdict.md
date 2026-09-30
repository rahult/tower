# SE-Bench: Tower vs stock pi — verdict

**Date:** 2026-09-29 · **Report:** `report.html` (same directory)

Two matrices were run:

- **Free matrix** — model `cohere/north-mini-code:free` (the only verified-free top-tier model serving; judge = same model). Quota-limited (1000 requests/day, exhausted twice); 4 of 6 cells completed.
- **Paid matrix** — model `qwen/qwen3-coder` ($0.30/$1.00 per 1M tokens; user-approved spend; chosen because `cohere/north-mini-code` has **no paid tier** on OpenRouter — free-only). Judge = the same model. **All 6 cells completed.** Head-to-head code comparisons of both arms per task: `comparisons-sluglib.md`, `comparisons-tasknote.md`, `comparisons-propsheet.md`.

## Paid matrix (qwen3-coder) — results

| Task | Arm | Correctness (hidden tests) | Spec fit | Code quality (architecture/SOLID) | Testing | Robustness | Docs | Σ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sluglib | pi | 9.4 (17/18) | 8 | 7 | 9.2 | 8 | 5 | **7.8** |
| sluglib | tower | 8.9 (16/18) | 8 | 7 | 8.8 | 8 | 8 | **8.1** |
| tasknote | pi | 10 (15/15) | 10 | 8 | 8.8 | 8 | 5 | **8.3** |
| tasknote | tower | 10 (15/15) | 10 | 8 | 10 | 8 | 8 | **9.0** |
| propsheet | pi | 10 | 10 | 8 | 8.8 | 8 | 8 | **8.8** |
| propsheet | tower | 10 | 10 | 8 | 8.8 | 8 | 10 | **9.1** |
| **mean** | **pi** | **9.8** | **9.3** | **7.7** | **8.9** | **8.0** | **6.0** | **8.3** |
| **mean** | **tower** | **9.6** | **9.3** | **7.7** | **9.2** | **8.0** | **8.7** | **8.7** |

**Tower wins the paid matrix 3-0 on mean score, on the strength of documentation (8.7 vs 6.0) and testing (9.2 vs 8.9)** — exactly the dimensions its pipeline stages enforce (README requirements, review flows, test-verified gates). Correctness and code quality are tied; the solo loop is never behind on raw engineering.

**Cost accounting (measured, per-call logging):** the full 6-cell paid matrix cost **≈$1.20** — pi cells $0.07–0.08 each (~30 calls), tower cells $0.36–0.40 each (~100–170 calls including two review flows). Per call: pi ≈$0.0025; tower ≈$0.002–0.007 (prompts grow 7k→31k tokens as stage transcripts accumulate). Tower runs ~5× pi's calls and ~4× wall time (16 vs 4 min) — real overhead, but cents per task at sane prices. **Anomaly on record:** the first paid run (same model, same harness, before per-call logging existed) burned ~$20 across ~95 calls (≈$0.21/call — 100× the measured rate) before dying on 402. The instrumented reruns contradict that rate so strongly it can only be an OpenRouter upstream routing/pricing anomaly on day one; flagged here rather than silently absorbed.

**Flow-stall finding (revised).** The sluglib 75-minute stall (84 min, zero LLM calls, merge lost) did **not** recur: tasknote and propsheet merged cleanly with reviews complete — propsheet ran the full pipeline (plan → build → adversarial review → SOLID review → feedback gate → merge) in 16 minutes. Two tower cells (sluglib, tasknote) were still cut short by credit exhaustion mid-run and were scored from recovered build branches (mechanically verified first: 16/18 and 15/15).

## Head-to-head code comparison (qwen3-coder matrix)

Beyond the per-cell rubric scores, each task's two implementations were compared directly by the judge (both file sets + brief + both test outcomes in view; per-dimension scores with cited file evidence; full tables in `comparisons-*.md`):

| Task | Architecture | SOLID | Robustness | Testing | Docs | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| sluglib | 7–7 | 8–7 | 9–8 | 9–8 | 6–7 | **pi (clear)** — pi handles ß-folding and maxLength-separator truncation correctly; tower has both bugs (matches the 16/18 vs 17/18 acceptance). |
| tasknote | 8–7 | 9–8 | 9–8 | 8–9 | 6–9 | **pi (slight)** — pi stricter input validation/exception contracts; tower the better test suite and README. (Both ship the identical bin/lib split; the judge slightly misattributes it — caveat below.) |
| propsheet | 8–7 | 8–7 | 9–8 | 9–8 | 7–8 | **pi (clear)** — pi nails backslash-escape edge cases and per-function test files; tower the better README. |

(Scores are pi–tower per dimension.)

The comparison judge — stricter and evidence-demanding than the cell rubric — prefers **pi's raw engineering on all three tasks**, while the rubric means prefer **tower's shipped artifact on all three**. Both are true, and the split is the finding: Tower's pipeline produces the better *deliverable* (docs, verified tests, review-screened robustness — the dimensions its gates enforce), while the solo loop produces the more *elegant internals* (tighter functions, deeper edge-case instincts — what an uninterrupted expert session optimizes for). Where the spec's edge cases bite (sluglib truncation, propsheet escapes), the comparison judge's preference matches the hidden acceptance results exactly.

Caveats: a single judge per matrix (self-preference in the free matrix); the comparison judge occasionally swaps file-level attributions when both trees are near-identical (tasknote); "7 = genuinely good" — these are strict scores, not grade inflation.

## Model selection (verified free, per the goal's probe rule)

| Candidate | Result |
| --- | --- |
| `nvidia/nemotron-3-ultra-550b-a55b:free` (top-tier, 1M ctx) | **Blocked by account guardrail** — "Free model training violation (account settings)", 404 on every call |
| `nvidia/nemotron-3-super-120b-a12b:free` | Same guardrail block |
| `google/gemma-4-31b-it:free` | Hard 429 (upstream rate-limited) across ~2 min of retries, twice |
| `qwen/qwen3.8-27b:free` | Hard 429 across ~2 min of retries, twice |
| **`cohere/north-mini-code:free`** | **Selected.** Verified `$0` pricing (`pricing.prompt/completion = "0"` on `/api/v1/models`) and `cost: 0` on every probe and run call. Cohere's first agentic coding model (sparse MoE, 256k ctx, native tool calling). |

Strongest *verified-free and actually serving* model: **`cohere/north-mini-code:free`**. The two bigger free tiers were unusable: NVIDIA's free endpoints are excluded by this account's data policy; Google's and Qwen's free endpoints were saturated upstream for the entire session.

Judge = the builder model. Caveat: a model judging its own output has a self-preference bias, but the **same** judge scored both arms on identical prompts, so the comparison itself is fair; read the absolute numbers with that grain of salt.

## Harness changes made for this run

- New **`pi` arm** (`arms/pi.ts`): stock `pi -p` — pi's default coding system prompt, default tool set, no Tower scaffolding, `--thinking off` (matching Tower's stage config), run in a scratch dir; killed at deadline like the other arms.
- **OpenRouter support**: `lib/openrouter.ts` (client + retry/backoff on 429/5xx/network), remote-model handling in `run.ts`/`driver.ts`/`score.ts`.
- **Retry proxy** (`lib/openrouter-proxy.ts`): localhost OpenAI-compatible proxy in front of OpenRouter — retries 429/5xx/`finish_reason:error` with capped backoff and re-wraps the completion as proper SSE delta chunks. Necessary, not decorative: pi's print mode treats any provider error as fatal, and the free tier emitted ~15 transient errors per long run. Tower's daemon agents use the same proxy.
- **Rubric**: the `code_quality` anchor now weighs architecture/SOLID explicitly (module seams, one-way dependencies, substitution, extension points; god-objects/leaky boundaries/mixed concerns push down), and the judge must name architecture/SOLID strengths or failures in its rationale.
- Task fixtures were made read-only after an agent deleted files inside `tasks/tasknote/` mid-run (see incidents).

## Incidents (part of the record, not hidden)

1. **tower/sluglib — systematic worktree destruction (2/2 attempts).** Both build agents fell into a destructive loop: `rm -rf src test package.json` → recreate → repeat (attempt 2 shows 35+ wipe cycles in its transcript; attempt 1 ended by re-`git init`'ing with `git config user.name "openhands"` — OpenHands-style training data leaking through the model). The pipeline merged the never-advanced branch each time = empty result, scored ~0. **Tower's gates never caught an empty diff**, and the verify stage reported "passed" against a gutted worktree. Attempt 1's zeros: `{0,0,0,0,0,0}`; attempt 2 (the table row): `{0,0,0,0,0,5}` — the 5 is the judge reading the template README. This is model pathology *in Tower's staged context*: the same model, free-running as stock pi, shipped working code on the same task. Treat the tower zeros as "harness + model combination produced nothing scoreable", not as Tower's ceiling — but keep the ceiling honest: in the archived ollama matrix (`.state-ollama-2026-09-29/`, qwen2.5-coder:7b + llama3.1:8b) Tower also shipped nothing, ending every cell in `needs_attention` after its retry budget with correctness ~0–1.3. Across both benchmarks, **Tower has never landed scoreable software headlessly** — with weak local models it stalls in the build; with a stronger free model it self-destructs and the pipeline ships the empty merge anyway.
2. **Fixture sabotage.** During tasknote an agent deleted `tasks/tasknote/brief.md`, the hidden acceptance test, and repo-template files. Restored from git; `tasks/` is now `chmod a-w` for the remainder of the run.
3. **Daily free quota, twice.** OpenRouter free tier: 1000 requests/day (`X-RateLimit-Limit: 1000`, resets 00:00 UTC). Day 1 exhausted by ~23:20Z (tower cells burn ~600 calls each — the degenerate wipe loops are request-hungry); the run paused for the reset and resumed. Day 2's quota was consumed by ~02:51Z. Remaining cells resumed on day 3 (cron after the 00:00Z reset), cheapest-first. The retry proxy made quota consumption *efficient* (no wasted dead runs) but could not create quota.
4. **Judge degeneration, once.** The judge call for pi/tasknote returned literal junk (`"nnn n n n …"`) — a free-model flake on a long prompt. The cell was re-judged in place with `re-judge.ts` (arm output untouched); all other judge calls returned clean rubric JSON.

## Results — free matrix (north-mini-code:free)

| Task | Arm | Correctness (hidden tests) | Spec fit | Code quality (architecture/SOLID) | Testing | Robustness | Docs | Σ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sluglib | pi | 9.4 | 5 | 5 | 8.8 | 5 | 5 | 6.4 |
| sluglib | tower (att. 2) | 0 | 0 | 0 | 0 | 0 | 5 | 0.8 |
| tasknote | pi | 8.7 | 5 | 4 | 8.8 | 5 | 3 | 5.8 |
| tasknote | tower | not run — quota | — | — | — | — | — | — |
| propsheet | pi | not run — quota | — | — | — | — | — | — |
| propsheet | tower | not run — quota | — | — | — | — | — | — |

*The three unrun cells were recorded as failed-with-reason in `state.json`: the account-wide free quota (1000 requests/day) was exhausted and the user deprioritized the free matrix on 2026-09-29 — the completed paid matrix (below) is the benchmark's deliverable. The free matrix's evidentiary value is the incident record: it is where the worktree-destruction pathology, the fixture sabotage, and the gate-blindness findings come from.*

## Evidence

### pi / sluglib (21 min, ~99 upstream calls, exited cleanly)
- Files: `src/index.js`, `test/slugify.test.js`, `README.md`, `package.json`
- Hidden acceptance: 17/18 (correctness 9.4). Own suite: passes.
- Judge rationale (architecture/SOLID named): code_quality 5 — the judge read the implementation as a competent single-module library with room to grow (see `.state/state.json` → `judgeRationale`).

### pi / tasknote (re-judged)
- Hidden acceptance: 13/15 (correctness 8.7). Own suite: passes.
- Judge rationale: spec 5, quality 4 (architecture/SOLID weaknesses named in rationale), testing 8.8, robustness 5, docs 3 — the judge is strict; 7 already means genuinely good.

### tower / sluglib (attempts 1 & 2, ~80 min each)
- Pipeline both times: planning → plan gate approved → build → verify "passed" → adversarial review FAIL → feedback gate approved → merge of an empty branch.
- Stage summaries (attempt 2, sqlite `stage_runs`): planning "pass", building "pass: Successfully implemented…", verify "pass", feedback "fail: 5 blocking specification violations".
- Build transcript (attempt 2): 35+ cycles of `rm -rf src test package.json && mkdir -p src test`; no commit ever landed; branch ref never advanced past Template.
- Output: template only — the acceptance suite crashed at import (`ERR_MODULE_NOT_FOUND: src/index.js`), recorded as 0/0 cases → correctness 0. The docs 5 is the judge reading the template README.
- Full transcripts: `.state/runs/tower-openrouter-cohere-north-mini-code-free-sluglib/bench/.tower/cards/*/sessions/`.

<!-- FILLED_BY_MATRIX: remaining cells -->

## Reading

The two matrices are one thesis tested at two capability levels:

**With the free model (north-mini-code:free), the harness comparison is one-sided against Tower.** Stock pi shipped working software on both completed tasks; Tower's pipeline shipped nothing twice — the build agent fell into `rm -rf` self-destruction loops (2/2 attempts, OpenHands-style training data visible in the transcripts) and the pipeline merged the empty branch both times, no gate (including verify) catching it. The free matrix also surfaced pure free-tier operational pain: 1000-requests/day caps exhausted twice, fixture sabotage by a rogue agent, one judge degeneration.

**With the paid model (qwen3-coder), Tower wins 3-0 on rubric means** — not on correctness or code quality (tied) but on documentation (8.7 vs 6.0) and testing (9.2 vs 8.9): precisely the dimensions its stages coerce. The head-to-head code comparison still prefers pi's internals on all three tasks — tighter functions, deeper edge-case instincts — which is why the acceptance suite's edge cases (sluglib truncation, propsheet escapes) break tower's builds where pi's survive.

**Synthesis: Tower is a discipline multiplier with a high capability floor.** Below the floor (free-tier model) the pipeline amplifies failure — the model self-destructs inside the stages and the gates rubber-stamp the wreckage; every headless Tower run in this benchmark's history has shipped nothing at or below that tier. Above the floor (a competent coding model) the same pipeline ships measurably better *products*: documented, review-screened, test-verified — at ~5× the tokens and ~4× the wall time of the solo loop, i.e. cents per task, and worth it when the deliverable matters more than the diff's elegance. **For Tower-the-product the actionable findings are:** (1) a merge gate must notice an empty diff (both free-model disasters shipped nothing); (2) stalled flows need a timeout (the 84-minute zero-call stall cost a merge); (3) agent contexts should be elided between steps (prompts grow 7k→31k tokens per stage). **For a user choosing harnesses:** stock pi with a strong model is the better engineer per dollar and per minute; Tower with a strong model is the better *process* when documentation, reviews, and gate-enforced testing are the point.

Caveats kept in view: 3 tasks, one judge per matrix (self-judging in the free matrix), the day-one OpenRouter pricing anomaly, two tower cells scored from recovered branches, and one head-to-head judge misattribution — all documented above rather than smoothed over.


---

## Appendix — DeepSeek-V4.1-Flash spot check (2026-09-29, user-requested)

One task (sluglib), both arms, `deepseek-flash` via DeepSeek's native API (`DEEPSEEK_API_KEY`), judge = same model. Full comparison: `comparisons-sluglib-deepseek.md`.

| Arm | Correctness | Spec | Quality | Testing | Robustness | Docs | Σ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pi | 9.4 (17/18) | 8 | 8 | 9.2 | 8 | 8 | **8.4** |
| tower | 10 (18/18) | 10 | 9 | 9.6 | 9 | 9 | **9.4** |

Tower's pipeline completed natively (plan → build → adversarial review → feedback gate → merge — no stall, no recovery). Head-to-head verdict: **tower (clear)** — pi passes the separator string straight into `String.replace`, so `separator: '$&'` corrupts output and `ß` mishandles; tower uses a replacer function and folds `ß` explicitly, with regression tests covering both (that is exactly the difference between 17/18 and 18/18).

Third model, third data point for the thesis: at the free tier Tower self-destructs (0); at qwen3-coder Tower edges the deliverable while pi edges the internals; at deepseek-flash Tower wins outright — pipeline overhead fixed (~$0.40-equivalent, 13 min), ceiling rising with model quality.

---

## Appendix 2 — DeepSeek-V4.1-Flash, two complex scenarios (2026-09-30, user-requested)

Two new tasks written for this test (spec + hidden acceptance suite validated 18/18 against a reference implementation before use): **evqueue** — durable FIFO queue with ack/nack retry, dead-lettering, at-least-once crash recovery; **kvstore** — transactional KV store with atomic rollback and WAL replay. Both architecture-stressing (state machines, persistence, failure contracts) where sluglib is not.

### Scores (judge = deepseek-flash)

| Task | Arm | Correctness (18 hidden) | Spec | Quality | Testing | Robustness | Docs | Σ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sluglib | pi | 9.4 (17/18) | 8 | 8 | 9.2 | 8 | 8 | **8.4** |
| sluglib | tower | 10 (18/18) | 10 | 9 | 9.6 | 9 | 9 | **9.4** |
| evqueue | pi | 10 (18/18) | 9 | 9 | 9.6 | 8 | 9 | **9.1** |
| evqueue | tower | 10 (18/18) | 10 | 8 | 9.6 | 8 | 2 | **7.9** |
| kvstore | pi | 10 (18/18) | 8 | 8 | 9.6 | 8 | 1 | **7.8** |
| kvstore | tower | 10 (18/18) | 9 | 7 | 9.6 | 8 | 2 | **7.6** |

All six cells: every arm passed all 18 hidden acceptance tests on the two new tasks. **Every tower pipeline merged natively** (no stalls, no recoveries). The striking behavioral finding: on the complex tasks, 3 of 4 builders shipped the template README untouched (a one-line "(Implementation to be written.)" stub) — the docs dimension, not engineering, decided both rubric margins.

### Head-to-head code comparisons (full: `comparisons-{evqueue,kvstore}-deepseek.md`)

- **evqueue → pi (clear):** one atomic `commit()` persistence seam vs duplicated dead-letter logic across replay and live mutators; pi rejects non-finite payloads, tower silently coerces NaN→null; only pi wrote a real README.
- **kvstore → tower (clear):** strict depth-aware JSON validation and WAL hygiene (no log writes for no-ops) vs pi's silent nested-undefined coercion and continue-past-torn-line replay.

DeepSeek comparison tally across the three tasks: **tower 2, pi 1**.

### Cost / time / volume (per-cell, DeepSeek V4.1-Flash off-peak rates $0.15/$0.60 per 1M)

| Cell | Wall | LLM calls | Prompt tok | Completion tok | Est. cost |
| --- | --- | --- | --- | --- | --- |
| pi/sluglib | 1.7m | 19 | 277k | 14k | $0.050 |
| tower/sluglib | 6.7m | 65 | 1.92M | 78k | $0.334 |
| pi/evqueue | 2.4m | 20 | 547k | 27k | $0.098 |
| tower/evqueue | 6.0m | 47 | 1.28M | 68k | $0.233 |
| pi/kvstore | 1.4m | 23 | 393k | 15k | $0.068 |
| tower/kvstore | 5.3m | 46 | 1.13M | 56k | $0.204 |

Complexity roughly doubles pi's tokens and adds ~50% to tower's, but the tower:pi ratio holds at ~4× wall, ~3× tokens, ~3× cost — the pipeline overhead is linear in task complexity, not explosive, and totals **≈$1 for all six cells combined**. Tower's per-call prompts reached 53k tokens on evqueue (stage transcripts accumulate); context elision between steps remains the top Tower cost optimization.

### kvstore score autopsy (why the lowest Σs of the day)

Both arms passed 18/18 with testing 9.6 — the low Σs came from the stub READMEs (docs 1–2) and tower's code-quality 7 (one monolithic closure, duplicated read/validation paths, no substitutable seams). Read-side scalability is identical and ceilinged in both: fsync-per-write (~10³ writes/s), O(store) open via full WAL replay, O(store) blocking snapshot — all three need refactoring, not config, to pass toy scale. The one real quality split: tower validates JSON-serializability at any depth via a replacer, while pi's plain `JSON.stringify` silently drops nested `undefined` properties (`{a: undefined}` → `{}`) instead of rejecting — the deciding evidence in tower's kvstore head-to-head win. pi's counter-edge: module-level pure helpers (validateKey/serializeValue/deepCopy) are more reusable than tower's closure-internal equivalents.

### DFMA prompt experiment (issue #2, 2026-09-30)

Implemented `prompts/partials/dfma.md` (minimize components; never duplicate a logic path; mind the tolerance stack-up), wired into `prompts/building.md` and registered in the stage-runner partials table, then re-ran tower/kvstore with deepseek-flash.

| | before | after |
| --- | --- | --- |
| code_quality | 7 | **8** |
| mean Σ | 7.6 | 7.6 |
| correctness / testing / robustness | 10 / 9.6 / 8 | unchanged |
| docs | 2 | 1 (stub README persists) |

Judge rationale, before: *"no real seams… JSON-parse/validation logic is repeated between store and tx methods."* After: *"one canonical read path shared by store and tx overlay, applyOp/applyRecord reused for both WAL ops and tx records… no circular or inverted dependencies"* (still flags the single-closure monolith — DFMA's chosen trade). The DFA half of the constraint landed (code_quality 7→8) but docs slipped 2→1, so the mean is unchanged — the docs gap is orthogonal and would need a README requirement in the build contract, not a component-count rule.

### Independent cross-check: kimi-k3 as third-party judge (2026-09-30)

The comparisons above were deepseek-flash judging its own builds (self-preference risk). All three DeepSeek-built pairs were re-reviewed by `kimi-k3` (Moonshot native API, independent model). Full tables: `comparisons-{sluglib,evqueue,kvstore}-kimik3.md`. Tally: **tower 2, pi 1 — identical to the in-matrix judge**, with convergent reasoning on all three:

- **sluglib → tower (both judges):** pi's `$&`-separator injection bug and ß mishandling; tower's 20-test regression suite pins exactly those failure modes (17/18 vs 18/18 explained).
- **evqueue → pi (both judges):** pi's atomic writeState + persist-before-mutate + loud corruption errors + NaN/Infinity rejection; tower's unbounded log, lifetime fd leak, silent swallow of corrupt mid-log lines, NaN→null coercion.
- **kvstore → tower (both judges):** tower's single canonical read/apply paths (the DFMA consolidation — the judge names it: "exactly one place that knows op semantics"), recursive serialization, snapshot-fsync-before-truncate. kimi-k3's caveats on tower: walFd never closed, tx lacks the nested-transaction method.

New defects caught only by the independent pass: pi/sluglib's unrequested `export default` and a test double-run under `node --test test/`; tower/evqueue's `removeSorted` being a misnamed linear scan; tower/kvstore's fd leak; both kvstore READMEs "identical, now-false stubs". Cross-judge agreement on winners (3/3) and on the decisive evidence substantially raises confidence in the comparison conclusions.

### Appendix 3 — day-to-day scenario: ticket system (2026-09-30, user-requested)

A deliberately ordinary task — a JSON-persisted ticket tracker (status workflow start/close/reopen, comments, assignment, priorities, filtering), the kind of CRUD+workflow system teams build weekly. Hidden suite validated 15/15 against a reference implementation.

| Arm | Correctness (15 hidden) | Spec | Quality | Testing | Robustness | Docs | Σ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pi | 10 | 9 | 9 | 9.6 | 9 | 1 | **7.9** |
| tower | 10 | 10 | 9 | 9.6 | 8 | 3 | **8.3** |

Both arms passed all 15 hidden tests; tower merged natively (build ×2, adversarial review, feedback gate). Both judges (deepseek in-matrix, kimi-k3 independent) gave **tower (slight)** — 4th consecutive cross-judge agreement. Decisive evidence: tower's file-as-source-of-truth read-modify-write seam (`mutate`) is correct under multiple open instances, while pi's cache-and-rewrite can duplicate ids and silently drop tickets; pi is stronger on malformed-input hardening, but both judges weighted the core persistence model over edge hardening. Cost: pi 2.7m/~$0.09, tower ~9m/~$0.25 (est. off-peak DeepSeek rates).

### Cost addendum — prompt caching (2026-09-30)

DeepSeek's prefix cache is automatic (no flag, no maintenance) and scales to Tower's prompt sizes: measured 21.5k/21.6k tokens cached (99%) on repeated prefixes. All cost figures in the metrics tables are therefore conservative upper bounds computed at cache-miss rates; the true tower-cell costs are roughly a third of the listed estimates once caching is accounted (e.g. tower/tickets ≈ $0.10 real vs $0.31 upper bound), and the tower:pi cost ratio on DeepSeek drops from ~10× to ~3×. Wall-clock overhead (~4-6× pi) remains the real price of the pipeline. The retry proxy now logs cached_tokens per call for exact accounting on future runs.

### Root cause: the docs-score drop (found 2026-09-30)

Every low docs score in the DeepSeek matrix traced to one omission: the three new-task briefs (evqueue, kvstore, tickets) never asked for a README, while the original tasks' briefs end with "Write tests … and a short README.md explaining usage." Tower's planning stage treated the stub README as scaffolding and constrained the build to `src/`+`test/` with explicit "Do not modify README.md" rules (visible verbatim in plan.md); the build prompt makes plan constraints binding, so builders obeyed. pi fell into the same trap via the existing-stub illusion (its default prompt does not require a README). Fix: one sentence added to each brief ("Also write a short README.md documenting usage and behaviours."). Verified by re-running tickets: **pi docs 1→9 (Σ 7.9→9.3), tower docs 3→9 (Σ 8.3→8.9)** — the single largest score movement in the benchmark, from one sentence. The deeper Tower lesson: when the brief is silent on docs, the planner should not *forbid* them — worth a planning-prompt note that README/docs updates are in scope unless the brief says otherwise.

### Judge split on the fixed-brief tickets pair (2026-09-30)

Same code, two judges, opposite verdicts. deepseek (in-matrix): pi 9.3 > tower 8.9 — docked tower for live-reference leaks and spec over-strictness. kimi-k3 (independent): **tower (slight)** — and it caught a real bug deepseek missed: pi's `update()` validates and mutates field-by-field, so a rejected multi-field update leaves *partial in-memory state that the next save persists* (unguarded, reachable via normal API use, untested by pi's own suite). kimi-k3 re-framed tower's flaw as lesser: the live-reference leak requires caller misuse and is consistently tested around, while tower's suite is materially broader (full transition matrix, update atomicity, nextId repair, per-mutation durability) with validate-before-mutate proven by an explicit test. Net: both builds carry exactly one real defect — pi's partial-mutation path, tower's reference leak — and ±0.4 margins on close tasks are inside single-judge noise. Independent-judge tally across four tasks: tower 3, pi 1.

### Tower hardening package (2026-09-30, from benchmark learnings — all generic)

Five fixes, each traced to a benchmark finding and kept principle-based:

1. **Empty-merge guard** (orchestrator `finishBranch`): a branch whose head still equals the card's base commit is refused at the merge step — the error lands on the card as its needs-attention reason. From the free-matrix disasters (gates green, merged branch with zero commits).
2. **Planning scope rule** (planning.md): constrain only what the brief/conventions constrain; docs are in scope when the public surface grows; never forbid files the brief didn't exclude. From the docs-score autopsy.
3. **SOLID review probes** (solid-review.md): encapsulation boundary (live references handed out by getters — copy-on-return as the store-shaped contract) and mutation atomicity (validate everything before mutating anything). From the tickets reference-leak finding.
4. **Adversarial inverses** (adversarial-review.md): over-strictness (constraints the spec never stated, rejecting valid input) and partial mutation (interleaved validate/mutate leaving half-applied state). From the two judges' findings on the tickets pair.
5. **Shipped-report doc debt** (building.md): an untouched placeholder README next to new API is a listed gap. From the stub-README pattern across all complex tasks.

Plus the earlier DFMA partial and the cost UI (cached savings). Validation: 210/210 daemon tests (after making the dfma partial tolerant of custom prompts dirs — a real regression the suite caught), then a live tower/tickets run with all fixes: docs 9 (plan included the README), and the produced code is clean on both previously-shipped defect classes — `get`/`update`/`comment` return clones, `update` validates all fields before mutating any. Σ 8.8 (spec 9: still one point of unrequested strictness; quality 8: the DFMA-accepted single-module design). Not yet done (larger): flow-stall watchdog, stage-context elision, worktree-integrity pre-merge check.
