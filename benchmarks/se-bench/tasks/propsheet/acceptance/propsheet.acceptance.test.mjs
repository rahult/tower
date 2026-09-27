// Hidden acceptance tests for the propsheet task.
// Usage: node propsheet.acceptance.test.mjs <target-dir>
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: node propsheet.acceptance.test.mjs <target-dir>");
	process.exit(2);
}
const { parse, stringify } = await import(pathToFileURL(join(dir, "src", "index.js")).href);

test("sections and keys", () => {
	const out = parse("[owner]\nname = Ada\nage = 36\n");
	assert.deepEqual(out, { owner: { name: "Ada", age: 36 } });
});

test("root keys before any section", () => {
	const out = parse("title = Hello\n[extra]\nn = 1\n");
	assert.deepEqual(out, { title: "Hello", extra: { n: 1 } });
});

test("comments and blank lines ignored", () => {
	const out = parse("# top\n; also\n\n[a]\nx = 1 # not a comment\n");
	assert.deepEqual(out, { a: { x: "1 # not a comment" } });
});

test("booleans coerce", () => {
	const out = parse("[f]\na = true\nb = false\nc = TRUE\n");
	assert.deepEqual(out, { f: { a: true, b: false, c: "TRUE" } });
});

test("numbers coerce", () => {
	const out = parse("[n]\na = 42\nb = -3\nc = 2.5\nd = 1e3\n");
	assert.deepEqual(out, { n: { a: 42, b: -3, c: 2.5, d: "1e3" } });
});

test("quoted strings unquote and unescape", () => {
	const out = parse('[q]\na = "hello"\nb = \'it\\\'s\'\nc = "say \\"hi\\""\nd = "C:\\\\path"\n');
	assert.deepEqual(out, { q: { a: "hello", b: "it's", c: 'say "hi"', d: "C:\\path" } });
});

test("values are trimmed", () => {
	const out = parse("[t]\na =    spaced    \n");
	assert.deepEqual(out, { t: { a: "spaced" } });
});

test("keys trimmed, case sensitive", () => {
	const out = parse("[K]\n  Key = 1\nkey = 2\n");
	assert.deepEqual(out, { K: { Key: 1, key: 2 } });
});

test("duplicate keys last wins", () => {
	const out = parse("[d]\nx = 1\nx = 2\n");
	assert.deepEqual(out, { d: { x: 2 } });
});

test("repeated section merges", () => {
	const out = parse("[s]\na = 1\n[t]\nb = 2\n[s]\nc = 3\n");
	assert.deepEqual(out, { s: { a: 1, c: 3 }, t: { b: 2 } });
});

test("malformed line throws with line number", () => {
	assert.throws(() => parse("[a]\nx = 1\noopsies\n"), (e) => e instanceof SyntaxError && e.message === "line 3: expected key=value");
});

test("empty input parses to empty object", () => {
	assert.deepEqual(parse(""), {});
});

test("stringify flat and nested", () => {
	const text = stringify({ a: "x", n: 3, yes: true, sec: { b: "y" } });
	assert.deepEqual(parse(text), { a: "x", n: 3, yes: true, sec: { b: "y" } });
});

test("stringify quotes only when needed", () => {
	const text = stringify({ plain: "hello", tricky: "has = inside", empty: "", hash: "a#b" });
	assert.match(text, /^plain=hello$/m);
	assert.match(text, /^tricky="has = inside"$/m);
	assert.match(text, /^empty=""$/m);
	assert.match(text, /^hash="a#b"$/m);
});

test("round trip nested", () => {
	const data = { title: "App", limit: 10, on: false, db: { host: "local = hmm", port: 5432, opts: "a;b" } };
	assert.deepEqual(parse(stringify(data)), data);
});

test("stringify escapes quotes and backslashes inside quoted strings", () => {
	const data = { s: 'say "hi" \\ ok' };
	const text = stringify(data);
	assert.deepEqual(parse(text), data);
});

test("parse is a plain object result", () => {
	const out = parse("[a]\nx = 1\n");
	assert.equal(Object.getPrototypeOf(out), Object.prototype);
	assert.equal(Object.getPrototypeOf(out.a), Object.prototype);
});
