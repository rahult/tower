# CLI tool

A zero-dependency Node command-line tool: plain ESM, a command dispatcher, vitest unit tests, and an
acceptance runner that drives the real binary. The baseline for command-line work built test-first.

| Command | What it does |
|---|---|
| `npm test` | unit tests |
| `npm run verify` | the bar every change must clear (tests) |
| `npm run accept` | acceptance specs against the real binary |
| `npm run accept -- --expect-red` | the red gate: exits 0 only when the specs this branch adds or changes all run and fail |

## The acceptance contract

Each file in `acceptance/specs/` exports a human-readable `name` and a `run` that drives the binary:

```js
import { assert, expectStatus } from "../helpers.mjs";

export const name = "greet says hello";

export async function run({ cli }) {
  const out = expectStatus(await cli(["greet", "ada"]), 0, "greet ada");
  assert(out.stdout.includes("Hello, ada!"), `unexpected output: ${out.stdout}`);
}
```

- `run({ cli })` exercises the tool through its real entry point — never by importing internals for
  the behavior under test (unit tests own those).
- Every `cli()` call runs in a **fresh throwaway working directory**, so file-writing commands are
  isolated by default; pass your own `cwd` when two invocations must share one.
- The green gate is `npm run accept`: exit 0 only when every spec passes. The red gate adds
  `--expect-red`: exit 0 only when **the specs this branch adds or changes** all fail, judged against
  the merge-base with the default branch; pre-existing specs report `SKIP`. A behavior-less branch
  commits `acceptance/NO-NEW-BEHAVIOR` with a one-line justification instead.

## House rules

1. **Test-first.** Acceptance specs drive the real binary; unit tests own the modules underneath.
2. **Never weaken a test to make it pass.**
3. **Zero dependencies.** `node:` built-ins only; a dependency needs a reason a plan states.
4. **Handlers return, they don't print.** Commands return `{ message, exitCode, error? }`; only the
   entry point writes to the console — so everything is testable without mocks.
5. **Exit codes are the contract.** 0 success, 64 usage, and mean it.
