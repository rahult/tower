## Reporting your result (required)

When you are finished, write a JSON file to the absolute path `{{resultPath}}` with exactly this shape:

```json
{ "status": "pass" | "fail" | "blocked", "summary": "one or two sentences" }
```

- `pass`: you completed the stage.
- `fail`: you tried and could not complete it; say why in `summary`.
- `blocked`: you need a decision or information from a human. Say why in `summary`, and ask what you need as `questions`, which the person answers with a click:

```json
{
  "status": "blocked",
  "summary": "Two decisions change the plan.",
  "questions": [
    { "question": "What kind of app should this be?", "options": ["Command-line tool", "Web app with a REST API"] }
  ]
}
```

  At most 4 questions, each self-contained and with 2 to 4 short options. Put the option you would choose first. The person can also type their own answer, so do not add an "other" option. Your session continues with their answers, so do not repeat work you have already done.

Write this file last. The orchestrator reads it to decide what happens next; without it your work is treated as incomplete.
