# Build: kvstore — a transactional key-value store with crash recovery

Create a small JavaScript library implementing an **embedded key-value store** with atomic transactions and write-ahead-log crash recovery. Node.js, no dependencies.

## Layout (required)

- `src/index.js` — the library entry point (ESM). It must export a function `openStore`.
- `test/` — tests runnable with `node --test`.

## Behaviour

`openStore(path)` opens (or creates) a store rooted at `path` and returns a store object. All API calls are **synchronous**.

1. `get(key)` — returns the value stored at `key`, or `undefined` if absent. `key` must be a string, else a `TypeError` with message `key must be a string`. **Values are returned as deep copies**: mutating an object you got from `get` must not affect the store.

2. `set(key, value)` — stores `value`. Same key validation; `value` must be JSON-serializable (functions, symbols, `undefined`, circular structures throw a `TypeError` with message `value must be JSON-serializable`). Storing the same key twice keeps the latest value.

3. `del(key)` — removes `key`; returns `true` if it existed, `false` otherwise. Same key validation.

4. `transaction(fn)` — runs `fn(tx)` where `tx` offers the same `get`/`set`/`del` semantics (including all validation and deep-copy behaviour). **Atomicity:** if `fn` throws, *none* of the transaction's changes apply — the store is exactly as before the call. If `fn` returns normally, all of its changes apply together. A transaction sees its own writes. Calling `transaction` from inside a transaction throws a `TypeError` with message `transactions cannot be nested`.

5. **Durability:** every committed mutation is appended to a write-ahead log before the call returns. `close()` writes a snapshot and clears the log. Opening a store applies the snapshot (if any) then replays the log, so **every committed change survives a crash** — a store that is reopened without `close()` (simulated crash) must show all `set`/`del`/committed-transaction effects.

6. Values round-trip through JSON: objects, arrays, numbers, strings, booleans, `null` all survive set→get and close→reopen unchanged.

Write your own tests in `test/` covering the happy path, rollback atomicity, and recovery. Also write a short `README.md` documenting usage and behaviours. No new dependencies; Node.js built-ins only.
