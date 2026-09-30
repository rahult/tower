# Cost report — real per-task spend with cache breakdown

Generated 2026-09-30. DeepSeek cells priced at off-peak rates (input $0.15/M miss · $0.003/M cache hit · output $0.60/M); peak hours (01–04, 06–10 UTC Mon–Fri) would double the miss/output figures. OpenRouter cells use the provider-reported per-call cost where present.

## cohere/north-mini-code:free

| Task | Arm | Wall | Calls | Prompt tok | Cached (hit%) | Completion tok | Cost | Basis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sluglib | pi | 22.6m | 99 | 0 | n/a | 0 | $0.000 | free tier ($0) |
| sluglib | tower | 77.3m | 1050 | 0 | n/a | 0 | $0.000 | free tier ($0) |
| tasknote | pi | 19.8m | 361 | 0 | n/a | 0 | $0.000 | free tier ($0) |
| **total** | | | | | | | **$0.000** | |

## qwen/qwen3-coder

| Task | Arm | Wall | Calls | Prompt tok | Cached (hit%) | Completion tok | Cost | Basis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| propsheet | pi | 1.7m | 30 | 323,763 | n/a | 5,679 | $0.082 | provider-reported |
| propsheet | tower | 15.9m | 93 | 1,560,683 | n/a | 20,219 | $0.360 | provider-reported |
| sluglib | pi | 3.2m | 27 | 0 | n/a | 0 | $0.078 | est: 27 calls (status lines) × sibling per-call $0.003 |
| sluglib | tower | 90.1m | 70 | 0 | n/a | 0 | $0.202 | est: 70 calls (status lines) × sibling per-call $0.003 |
| tasknote | pi | 1.7m | 27 | 270,916 | n/a | 5,538 | $0.069 | provider-reported |
| tasknote | tower | 0.9m | 169 | 2,656,061 | n/a | 17,530 | $0.405 | provider-reported |
| **total** | | | | | | | **$1.196** | |

## deepseek-flash

| Task | Arm | Wall | Calls | Prompt tok | Cached (hit%) | Completion tok | Cost | Basis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evqueue | pi | 2.4m | 20 | 547,466 | n/a | 27,124 | $0.098 | rate card × tokens |
| evqueue | tower | 6m | 47 | 1,284,401 | n/a | 67,668 | $0.233 | rate card × tokens |
| kvstore | pi | 1.4m | 23 | 392,909 | n/a | 14,539 | $0.068 | rate card × tokens |
| kvstore | tower | 7.6m | 84 | 2,828,415 | n/a | 85,278 | $0.475 | rate card × tokens |
| sluglib | pi | 1.7m | 19 | 277,211 | n/a | 13,657 | $0.050 | rate card × tokens |
| sluglib | tower | 6.7m | 65 | 1,916,206 | n/a | 78,160 | $0.334 | rate card × tokens |
| tickets | tower | 9.1m | 80 | 2,730,906 | 2,594,048 (95%) | 108,494 | $0.093 | rate card × tokens |
| webnote | pi | 1m | 14 | 130,193 | 124,928 (96%) | 9,863 | $0.007 | rate card × tokens |
| webnote | tower | 7.2m | 69 | 2,321,966 | 2,253,696 (97%) | 74,891 | $0.062 | rate card × tokens |
| **total** | | | | | | | **$1.421** | |

## Judges and comparisons

19 judge calls + 13 head-to-head comparisons: 117,265 prompt + 62,960 completion tokens.
The deepseek-judged share prices at ~$0.055; the kimi-k3 comparisons are token-reported only (Moonshot native billing).

## Grand total

- cohere/north-mini-code:free: $0.000
- qwen/qwen3-coder: $1.196
- deepseek-flash: $1.421
- **all models: $2.618**
