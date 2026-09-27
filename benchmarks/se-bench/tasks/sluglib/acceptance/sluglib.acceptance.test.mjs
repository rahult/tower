// Hidden acceptance tests for the sluglib task.
// Usage: node sluglib.acceptance.test.mjs <target-dir>
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: node sluglib.acceptance.test.mjs <target-dir>");
	process.exit(2);
}
const { slugify } = await import(pathToFileURL(join(dir, "src", "index.js")).href);

test("basic words", () => {
	assert.equal(slugify("Hello, World!"), "hello-world");
});
test("already clean", () => {
	assert.equal(slugify("hello world"), "hello-world");
});
test("ampersand becomes and", () => {
	assert.equal(slugify("Salt & Pepper"), "salt-and-pepper");
});
test("diacritics fold", () => {
	assert.equal(slugify("Café Crème -- déjà vu"), "cafe-creme-deja-vu");
});
test("german style", () => {
	assert.equal(slugify("Über Straße"), "uber-strasse");
});
test("numbers kept", () => {
	assert.equal(slugify("Chapter 42: The Beginning"), "chapter-42-the-beginning");
});
test("collapses punctuation runs", () => {
	assert.equal(slugify("a!!!b???c"), "a-b-c");
});
test("trims and collapses whitespace", () => {
	assert.equal(slugify("   lots    of    space   "), "lots-of-space");
});
test("empty string", () => {
	assert.equal(slugify(""), "");
});
test("whitespace only", () => {
	assert.equal(slugify("   "), "");
});
test("custom separator", () => {
	assert.equal(slugify("Hello World", { separator: "_" }), "hello_world");
});
test("custom separator single char run", () => {
	assert.equal(slugify("a - b", { separator: "+" }), "a+b");
});
test("maxLength truncates", () => {
	assert.equal(slugify("Hello World", { maxLength: 6 }), "hello");
});
test("maxLength cuts without trailing separator", () => {
	assert.equal(slugify("Hello World", { maxLength: 8 }), "hello-wo");
});
test("maxLength larger than result", () => {
	assert.equal(slugify("Hi", { maxLength: 50 }), "hi");
});
test("non-string throws TypeError", () => {
	assert.throws(() => slugify(42), (e) => e instanceof TypeError && e.message === "input must be a string");
	assert.throws(() => slugify(null), TypeError);
	assert.throws(() => slugify(["a"]), TypeError);
});
test("options optional and unknown options ignored", () => {
	assert.equal(slugify("Hello World", {}), "hello-world");
	assert.equal(slugify("Hello World", { camel: true }), "hello-world");
});
test("tabs and newlines are separators", () => {
	assert.equal(slugify("one\ttwo\nthree"), "one-two-three");
});
