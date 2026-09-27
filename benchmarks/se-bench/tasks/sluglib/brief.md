# Build: sluglib

Create a small JavaScript library that converts arbitrary strings into URL-safe slugs.

## Layout (required)

- `src/index.js` — the library entry point (ESM). It must export a function `slugify`.
- `test/` — tests runnable with `node --test`.

## Behaviour of `slugify(input, options)`

1. `input` must be a string; anything else throws a `TypeError` with message `input must be a string`.
2. Convert to lowercase and trim surrounding whitespace.
3. Fold diacritics to ASCII (é→e, ñ→n, ü→u, à→a …) using Unicode normalization.
4. Replace every `&` with the word `and` (with a space either side) before any other processing.
5. After steps 2–4, replace every run of characters that are not `a-z`, `0-9`, or a space with a single space, then replace every run of one or more spaces with the separator.
6. The separator defaults to `-`. `options.separator` (a string) replaces it. If `options.separator` is not a string, the default is used.
7. `options.maxLength` (a positive integer): the result is truncated to at most that many characters, and any trailing separators left by the cut are removed.
8. Empty or whitespace-only input returns `""`.
9. `options` itself is optional; unknown options are ignored.

## Examples

- `slugify("Hello, World!")` → `"hello-world"`
- `slugify("Salt & Pepper")` → `"salt-and-pepper"`
- `slugify("Café Crème -- déjà vu")` → `"cafe-creme-deja-vu"`
- `slugify("Hello World", { maxLength: 6 })` → `"hello"`
- `slugify("Hello World", { separator: "_" })` → `"hello_world"`

## Constraints

- No dependencies. Node.js built-ins only.
- Do not modify the `"test"` script in `package.json`.
- Write tests for the behaviour above in `test/`, and a short `README.md` explaining usage.
