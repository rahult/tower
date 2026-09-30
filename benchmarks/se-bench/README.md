# se-bench — Tower vs. stock pi vs. raw scaffolding

A small, self-contained benchmark asking one question: **does Tower's discipline produce
better software than the same model without it?** Same three task briefs, same model, two
amounts of scaffolding — Tower's full pipeline vs. stock `pi -p` as a user would run it —
no human anywhere. Results land in `report.html` as spider charts over six
software-engineering dimensions; the 2026-09 pi-vs-tower run on a free OpenRouter model is
written up in `verdict.md`.

## Arms

| arm | what runs |
| --- | --- |
| `raw` | one chat completion, no tools; `FILE:`-marked code blocks are written to disk (ollama models only) |
| `basic` | a minimal agent loop: write/read/list/bash/finish tools, 48 steps, no gates, no reviews (ollama models only) |
| `pi` | **stock `pi -p`**: pi's default coding prompt and default tool set, `--thinking off`, scratch dir, deadline kill — no Tower scaffolding |
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
robustness / docs** (fixed anchored rubric, brief + full file tree + both test outcomes in
view). The code_quality anchor weighs architecture/SOLID explicitly: module seams,
one-way dependencies, substitution, extension points. One judge scores every arm, so its
bias is shared, not eliminated.

## Running

Local models (ollama, judge = qwen2.5-coder:7b-16k):

```sh
ollama serve                    # qwen2.5-coder:7b and llama3.1:8b pulled
node run.ts                     # full matrix: 2 models × 3 tasks × 3 arms, sequential
node run.ts --models=qwen2.5-coder:7b --tasks=sluglib --arms=basic,tower
```

Remote models (OpenRouter, `OPENROUTER_API_KEY` in env; a model prefixed `openrouter/`
is remote, anything else is an ollama tag; the first remote model becomes the judge unless
`--judge=` is given; `raw`/`basic` are ollama-only):

```sh
node run.ts --models=openrouter/cohere/north-mini-code:free \
            --tasks=sluglib,tasknote,propsheet --arms=pi,tower \
            --pi-minutes=35 --tower-minutes=90
node run.ts --only report --judge=openrouter/cohere/north-mini-code:free
node check-cells.ts [model]     # audit: every cell present? judge parse failures flagged
node re-judge.ts '<arm:model:task>' [judge]   # re-score one cell's judge dims in place
```

Runs are resumable: finished cells live in `.state/state.json` and are skipped (failed
cells rerun). Per-run logs are in `.state/logs/`. One runner at a time (`.state/lock`).

## Infrastructure notes (the honest bits)

- **ollama context**: derived `-16k` model tags (`ollama create` with `num_ctx 16384`) —
  pi's OpenAI-compatible requests can't set per-request context.
- **tool-call proxy** (`tower/ollama-proxy.ts`): pi needs structured tool calls over the
  /v1 protocol; ollama's parser only converts them when the model's raw output matches its
  template exactly, which fails exactly when the prompt is big and real. The proxy calls
  ollama's native API non-streaming, converts text-form tool calls (both `arguments` and
  `parameters` spellings) into structured ones, and emulates OpenAI streaming.
- **OpenRouter retry proxy** (`lib/openrouter-proxy.ts`): the free tier throttles hard
  (429s, transient `finish_reason:error`), and pi's print mode treats any provider error
  as fatal. The proxy retries with capped backoff and re-wraps the completion as proper
  SSE delta chunks; both the `pi` arm and Tower's daemon agents point at it via a private
  `models.json`. Prompts, tools, and pi itself are untouched — only the endpoint changes.
- **no-human tower**: `tower/driver.ts` polls the card, rubber-stamps `plan_approval`,
  `feedback` (with `acknowledgeBlocking`), and `budget` gates, answers stage questions,
  and retries `needs_attention` cards with the brief's policy as feedback. Tower's own
  accounting (`towerTokens`) is recorded per run.
- **single judge**: same judge for every arm, so bias is shared, not eliminated.

## Reading the results

Small task set, one machine, one model, one judge: this is a disciplined smoke test of
the discipline thesis, not leaderboard truth. The interesting signals are the *shape* of
each arm's polygon and where Tower's gates cost or gain, per model. See `verdict.md` for
the pi-vs-tower run (including where the headless pipeline shipped empty merges that no
gate caught).
