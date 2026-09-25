# Acceptance specs

One `.mjs` file per behavior; the file name is the slug of the behavior (`create-note.mjs`). Each file
exports a human-readable `name` and a `run` that exercises the application over HTTP:

```js
import { assert, expectStatus, json } from "../helpers.mjs";

export const name = "a created note appears in the list";

export async function run({ baseUrl }) {
  const created = await json(await fetch(`${baseUrl}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: `spec-${Math.random()}` }),
  }));
  const list = await json(await fetch(`${baseUrl}/api/notes`));
  assert(list.some((note) => note.id === created.id), "the created note is missing from the list");
}
```

The database is throwaway and empty at the start of every run; specs run in file-name order against
one backend. `npm run accept` must exit 0 (green) before work counts as done; `npm run accept --
--expect-red` must exit 0 (red) the moment a branch's specs exist and their behavior does not. The
red gate judges only the specs the branch adds or changes (against the merge-base with the default
branch) and reports pre-existing ones as `SKIP` — they already describe shipped behavior and must
keep passing.
