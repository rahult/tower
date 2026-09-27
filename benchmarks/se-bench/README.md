# se-bench — Tower vs. raw model vs. basic loop

A small, self-contained benchmark asking one question: **does Tower's discipline produce
better software than the same model without it?** Same three task briefs, same local
ollama models, three amounts of scaffolding, no human anywhere. Results land in
`report.html` as spider charts over six software-engineering dimensions.

## Arms

| arm | what runs |
| --- | --- |
| `raw` | one chat completion, no tools; `FILE:`-marked code blocks are written to disk |
| `basic` | a minimal agent loop: write/read/list/bash/finish tools, 48 steps, no gates, no reviews. Falls back to applying markdown code blocks when the model won't emit tool calls (local models often don't) |
| `tower` | the real daemon + pi against a scratch repo: plan coach, plan gate, verify gate, acceptance red/green gates, testing stage, shipped review flows, feedback gate, local merge. A driver script plays the person: approves every gate, answers stage questions with the brief's own policy ("no new dependencies, built-ins only"), retries blocked builds (max 5) |

## Tasks

Three zero-dependency Node.js projects with pinned layouts and precisely specified
behaviour, so hidden acceptance tests can grade them mechanically:

- `sluglib` — slugify string library (unicode folding, separators, maxLength)
- `tasknote` — JSON-file-backed todo CLI (exact output formats and exit codes)
- `propsheet` — INI-style parser (typed values, quoting, stringify round-trip)

Every arm receives the identical `tasks/<task>/brief.md`. The acceptance suites under
`tasks/<task>/acceptance/` are never shown to any arm.

## Scoring

Six dimensions, 0–10: **correctness** (hidden acceptance pass rate — fully programmatic),
**testing** (60% own-suite-exists-and-passes, 40% judge), and **spec fit / code quality /
robustness / docs** (qwen2.5-coder:7b as judge, fixed anchored rubric, brief + full file
tree + both test outcomes in view).

## Running

```sh
ollama serve                    # qwen2.5-coder:7b and llama3.1:8b pulled
node run.ts                     # full matrix: 2 models × 3 tasks × 3 arms, sequential
node run.ts --only report       # rebuild report.html from .state/state.json
node run.ts --models=qwen2.5-coder:7b --tasks=sluglib --arms=basic,tower
```

Runs are resumable: finished cells live in `.state/state.json` and are skipped. Per-run
logs are in `.state/logs/`. One runner at a time (`.state/lock`).

## Infrastructure notes (the honest bits)

- **ollama context**: derived `-16k` model tags (`ollama create` with `num_ctx 16384`) —
  pi's OpenAI-compatible requests can't set per-request context.
- **tool-call proxy** (`tower/ollama-proxy.ts`): pi needs structured tool calls over the
  /v1 protocol; ollama's parser only converts them when the model's raw output matches its
  template exactly, which fails exactly when the prompt is big and real. The proxy calls
  ollama's native API non-streaming, converts text-form tool calls (both `arguments` and
  `parameters` spellings) into structured ones, and emulates OpenAI streaming.
- **no-human tower**: `tower/driver.ts` polls the card, rubber-stamps `plan_approval`,
  `feedback` (with `acknowledgeBlocking`), and `budget` gates, answers stage questions,
  and retries `needs_attention` cards with the brief's policy as feedback. Tower's own
  accounting (`towerTokens`) is recorded per run.
- **single 7–8B judge**: same judge for every arm, so bias is shared, not eliminated.

## Reading the results

Small task set, one machine, local 7–8B models, one local judge: this is a disciplined
smoke test of the discipline thesis, not leaderboard truth. The interesting signals are
the *shape* of each arm's polygon and where Tower's gates cost or gain, per model.
