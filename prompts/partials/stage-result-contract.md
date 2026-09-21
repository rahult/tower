## Reporting your result (required)

When you are finished, write a JSON file to the absolute path `{{resultPath}}` with exactly this shape:

```json
{ "status": "pass" | "fail" | "blocked", "summary": "one or two sentences" }
```

- `pass`: you completed the stage.
- `fail`: you tried and could not complete it; say why in `summary`.
- `blocked`: you need a decision or information from a human; put the question in `summary`.

Write this file last. The orchestrator reads it to decide what happens next; without it your work is treated as incomplete.
