# Build: tickets — a simple ticket system

Create a small JavaScript library implementing a **ticket-tracking system** of the kind every team ends up building: tickets with a status workflow, comments, assignment, priorities, and filtering, persisted to a JSON file. Node.js, no dependencies.

## Layout (required)

- `src/index.js` — the library entry point (ESM). It must export a function `openTickets`.
- `test/` — tests runnable with `node --test`.

## Behaviour

`openTickets(path)` opens (or creates) a ticket store backed by the file at `path` and returns a store object. All API calls are **synchronous**; every mutation is durable before the call returns.

A ticket is a plain object:

```js
{ id, title, status, priority, assignee, createdAt, comments }
```

- `id`: integer, starts at `1`, increases by `1`, never reused across reopen.
- `status`: one of `"open"`, `"in_progress"`, `"closed"`.
- `priority`: one of `"low"`, `"medium"`, `"high"` (default `"medium"`).
- `assignee`: a string or `null` (default `null`).
- `createdAt`: an ISO 8601 timestamp string.
- `comments`: array of `{ body, at }` where `at` is an ISO 8601 timestamp.

### API

1. `create({ title, priority?, assignee? })` — creates a ticket (status `"open"`, empty comments). `title` must be a non-empty string, else `TypeError` with message `title must be a non-empty string`. `priority`, when given, must be one of the three values, else `TypeError` with message `invalid priority`. Returns the ticket.

2. `get(id)` — returns the ticket, or `undefined` if none. Non-integer id throws `TypeError` (`id must be an integer`).

3. `list(filter = {})` — returns all tickets as an array sorted by ascending id, optionally filtered by `filter.status` and/or `filter.assignee` (exact match; an invalid `filter.status` value returns an empty array rather than throwing).

4. `update(id, changes)` — applies `changes.title` / `changes.priority` / `changes.assignee` (same validation as `create`; unknown keys are ignored). Throws `RangeError` with message `no ticket with id ${id}` for an unknown id. Returns the updated ticket.

5. `transition(id, action)` — moves the ticket through the workflow. Valid actions and their allowed source states:
   - `"start"`: `open` → `in_progress`
   - `"close"`: `open` or `in_progress` → `closed`
   - `"reopen"`: `closed` → `open`
   
   An action whose source state doesn't match throws an `Error` with message `invalid transition: <status> -> <action>`. Unknown id throws the same `RangeError` as `update`. Returns the updated ticket.

6. `comment(id, body)` — appends `{ body, at }` to the ticket's comments (`body` must be a non-empty string, else `TypeError` with message `body must be a non-empty string`). Unknown id throws the same `RangeError`. Returns the ticket.

7. **Persistence:** all state lives in the file at `path`; a new `openTickets(path)` instance sees everything (tickets, statuses, comments). Timestamps must be real (later operations have `>=` earlier timestamps).

Write your own tests in `test/` covering the workflow transitions, validation errors, filtering, and persistence. Also write a short `README.md` documenting usage and behaviours. No new dependencies; Node.js built-ins only.
