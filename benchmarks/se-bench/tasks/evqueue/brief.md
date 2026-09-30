# Build: evqueue — a durable event queue

Create a small JavaScript library implementing a **durable FIFO event queue** with at-least-once delivery, acknowledgement, retry, and dead-lettering. Node.js, no dependencies.

## Layout (required)

- `src/index.js` — the library entry point (ESM). It must export a function `openQueue`.
- `test/` — tests runnable with `node --test`.

## Behaviour

`openQueue(path)` opens (or creates) a queue backed by the file at `path` and returns a queue object. All API calls below are **synchronous**; every mutation must be durable *before* the call returns (a crash at any point must never lose an acknowledged state or resurrect an acked message).

1. `enqueue(payload)` — appends a message. `payload` must be JSON-serializable; functions, symbols, `undefined`, and circular structures throw a `TypeError` with message `payload must be JSON-serializable`. Returns the message's integer `id`. Ids start at `1`, increase by `1` per message, and are **never reused** — not even after closing and reopening the queue.

2. `dequeue()` — returns a plain object `{ id, payload, attempts }` for the oldest *available* message and marks it **in-flight**, or `null` if no message is available. `attempts` is the number of times this message has been nacked so far (starts at `0`).

3. `ack(id)` — permanently removes the in-flight message with that id. Throws a `RangeError` with message `no in-flight message with id ${id}` if no in-flight message has that id.

4. `nack(id)` — returns the in-flight message to the available set and increments its attempts. Throws the same `RangeError` for an unknown id. **Dead-letter rule:** `maxAttempts` is `3`; when a nack raises a message's attempts to `3`, the message moves to the dead-letter list instead of becoming available.

5. `dead()` — returns an array of `{ id, payload, attempts }` snapshots for dead-lettered messages, in dead-lettering order. A fresh queue returns `[]`.

6. **Recovery / at-least-once:** opening a queue on a path that already has state sees all previous enqueues, acks, and dead-letters. Messages that were in-flight when the previous instance stopped (no `ack`/`nack` for them) become **available** again.

7. Ordering: dequeue order is strictly FIFO by id. A nacked message resumes its original position in the id order (i.e. it is the next available message if it has the smallest id).

8. `payload` values round-trip through JSON: objects, arrays, numbers, strings, booleans, and `null` all survive a close/reopen unchanged.

Write your own tests in `test/` covering the happy path and the failure contracts (nack retry counting, dead-lettering, reopen recovery). Also write a short `README.md` documenting usage and behaviours. No new dependencies; Node.js built-ins only.
