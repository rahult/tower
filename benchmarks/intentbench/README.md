# IntentBench v0.1 — Tower baseline experiment

Five fixed product-intent inputs, pre-registered ambiguity labels, and a deterministic scoring tool. **These labels are hypotheses to be independently reviewed**, not ground truth. Do not expose reference labels to the evaluated planner.

## Run

1. Run each `input` from `cases.json` through Tower's **existing planning stage** without changing its prompt. Use a separate card per case; preserve the raw plan, questions, and model/version, timing, tokens and cost if available.
2. A reviewer annotates the resulting plan using the labels in `cases.json`, with supporting quotations. Store annotations as a JSON array; see `sample-annotations.json`. Use `detected` for supported ambiguity discoveries and `violations` for unsupported decisions. Do not give credit for vague mentions.
3. Run `node benchmarks/intentbench/evaluate.mjs benchmarks/intentbench/sample-annotations.json` to validate the scoring pipeline. Replace the sample with independently reviewed real-run annotations to obtain actual baseline scores.
4. Repeat with normalization, then independent interpretations. Keep models, input context, temperature and judging process as comparable as possible. Report latency, cost, questions and material disagreements separately.

**Scoring:** micro-recall = detected expected labels / all expected labels; violations = forbidden-label occurrences. The evaluator rejects unknown case IDs, unknown labels, duplicates and missing cases. This is not a correctness oracle. A human reviewer must check that labels reflect the original intent and that questions are consequential.

**Important:** The sample annotations are synthetic plumbing tests, **not Tower runs**. No agent execution or quality claim is implied. The baseline requires a live Tower/pi environment and configured model credentials.

## Success gate

Only consider a normalization flow promising if independently adjudicated ambiguity recall improves without a material rise in unsupported assumptions, clarification burden, or cost. Five examples are a smoke test, not statistically meaningful evidence.
