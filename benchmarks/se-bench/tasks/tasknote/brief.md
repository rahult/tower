# Build: tasknote — a tiny todo CLI

Create a command-line todo list tool called `tasknote`. Node.js, no dependencies.

## Layout (required)

- `bin/tasknote.js` — the CLI entry point, with shebang `#!/usr/bin/env node`. It must work when run as `node bin/tasknote.js <command> …` from any working directory.
- `test/` — tests runnable with `node --test`.
- `lib/` — implementation modules (how you split it up is up to you).

## Data

State lives in a JSON file named `.tasknote.json` in the **current working directory**. It holds a JSON array of tasks, each:

```json
{ "id": 1, "text": "buy milk", "priority": 2, "done": false, "createdAt": "2026-01-01T00:00:00.000Z" }
```

- `id`: integer, starting at 1; new tasks get `max(existing ids) + 1` (1 when empty; ids of removed tasks are never reused while larger ids exist).
- `priority`: integer, default 1.
- `createdAt`: ISO timestamp of creation.

## Commands

- `add "<text>" [--priority <n>]`
  Creates a task. Prints exactly `#<id> <text>` and nothing else. Exit code 0.
  `--priority <n>` sets the priority (integer; default 1).

- `list [--all]`
  By default lists only open (not done) tasks. With `--all`, done tasks are listed too.
  Each line is exactly:
  - open: `[ ] #<id> <text> (p<priority>)`
  - done: `[x] #<id> <text> (p<priority>)`
  Order: open tasks before done; within each group, priority descending, then id ascending.
  Empty list prints nothing. Exit code 0.

- `done <id>`
  Marks the task done. Prints exactly `done #<id>`. Exit code 0.
  Unknown id: prints `no task <id>` to stderr, exit code 1.

- `rm <id>`
  Removes the task. Prints exactly `removed #<id>`. Exit code 0.
  Unknown id: prints `no task <id>` to stderr, exit code 1.

- Unknown command, or a missing required argument: print a one-line usage summary to stderr, exit code 1.

## Constraints

- No dependencies. Node.js built-ins only.
- Do not modify the `"test"` script in `package.json`.
- Write tests (spawn the CLI against a temp directory), and a short `README.md` documenting the commands.
