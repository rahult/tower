# Build: propsheet — an INI-style config parser

Create a small library that parses and writes INI-style configuration text.

## Layout (required)

- `src/index.js` — the library entry point (ESM). It must export `parse` and `stringify`.
- `test/` — tests runnable with `node --test`.

## `parse(text)`

Takes a string, returns a plain object.

- Split the text into lines. A line whose first non-whitespace character is `#` or `;` is a comment. Blank (whitespace-only) lines are ignored.
- A line of the form `[name]` starts a section. The name is trimmed and case-sensitive. Keys that appear before any section header go into the result's top level.
- A `key=value` line: the key is trimmed and case-sensitive; the value is trimmed. Value coercion, in order:
  1. If wrapped in matching single or double quotes, it is a string: strip the quotes and process backslash escapes (`\"` → `"`, `\'` → `'`, `\\` → `\`). Any other backslash stays as-is.
  2. Else if it is exactly `true` or `false`, it becomes a boolean.
  3. Else if it is an integer or decimal number (optional leading `-`, digits, optional `.digits`, e.g. `42`, `-3`, `2.5`), it becomes a number.
  4. Otherwise it stays a string (the trimmed text).
- Duplicate keys: the last one wins. Repeating a `[section]` header merges into the same object.
- A non-empty line that is not a comment, not a section header, and has no `=` is malformed: throw a `SyntaxError` whose message is exactly `line <N>: expected key=value` where `<N>` is the 1-based line number.
- The result contains root keys at the top level and one nested object per section. Sections and root keys live side by side.

## `stringify(data)`

Takes a plain object (strings, numbers, booleans, and one level of nested plain objects) and returns INI text.

- Top-level scalar keys are written as `key=value` lines first.
- Then each nested object is written as a `[key]` section header followed by its `key=value` lines.
- Booleans and numbers are written unquoted. Strings are written quoted (double quotes, with `"` and `\` escaped) only when they are empty or contain `=`, `#`, `;`, a newline, or leading/trailing whitespace; otherwise raw.
- Round-trip guarantee: for any data of that shape, `parse(stringify(data))` deep-equals `data`.

## Constraints

- No dependencies. Node.js built-ins only.
- Do not modify the `"test"` script in `package.json`.
- Write tests for the behaviour above in `test/`, and a short `README.md` explaining the format.
