// Hidden acceptance tests for the tasknote task.
// Usage: node tasknote.acceptance.test.mjs <target-dir>
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const dir = process.argv[2];
if (!dir) {
	console.error("usage: node tasknote.acceptance.test.mjs <target-dir>");
	process.exit(2);
}
const cli = join(dir, "bin", "tasknote.js");

async function fresh() {
	const cwd = await mkdtemp(join(tmpdir(), "tasknote-"));
	return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
const tasknote = (cwd, ...args) => run(process.execPath, [cli, ...args], { cwd });

test("add prints the id line", async () => {
	const t = await fresh();
	const { stdout } = await tasknote(t.cwd, "add", "buy milk");
	assert.equal(stdout.trim(), "#1 buy milk");
	await t.cleanup();
});

test("add with priority", async () => {
	const t = await fresh();
	const { stdout } = await tasknote(t.cwd, "add", "ship it", "--priority", "3");
	assert.equal(stdout.trim(), "#1 ship it");
	const data = JSON.parse(await readFile(join(t.cwd, ".tasknote.json"), "utf8"));
	assert.equal(data[0].priority, 3);
	assert.equal(data[0].done, false);
	await t.cleanup();
});

test("ids increment from max", async () => {
	const t = await fresh();
	await tasknote(t.cwd, "add", "a");
	const { stdout } = await tasknote(t.cwd, "add", "b");
	assert.equal(stdout.trim(), "#2 b");
	await t.cleanup();
});

test("list shows open tasks in the exact format", async () => {
	const t = await fresh();
	await tasknote(t.cwd, "add", "first", "--priority", "1");
	await tasknote(t.cwd, "add", "urgent", "--priority", "5");
	const { stdout } = await tasknote(t.cwd, "list");
	assert.equal(stdout, "[ ] #2 urgent (p5)\n[ ] #1 first (p1)\n");
	await t.cleanup();
});

test("list hides done unless --all", async () => {
	const t = await fresh();
	await tasknote(t.cwd, "add", "one");
	await tasknote(t.cwd, "add", "two");
	await tasknote(t.cwd, "done", "1");
	assert.equal((await tasknote(t.cwd, "list")).stdout, "[ ] #2 two (p1)\n");
	const all = (await tasknote(t.cwd, "list", "--all")).stdout;
	assert.equal(all, "[ ] #2 two (p1)\n[x] #1 one (p1)\n");
	await t.cleanup();
});

test("list sorts by priority desc then id asc", async () => {
	const t = await fresh();
	await tasknote(t.cwd, "add", "low");
	await tasknote(t.cwd, "add", "high", "--priority", "9");
	await tasknote(t.cwd, "add", "also-high", "--priority", "9");
	const { stdout } = await tasknote(t.cwd, "list");
	assert.equal(stdout, "[ ] #2 high (p9)\n[ ] #3 also-high (p9)\n[ ] #1 low (p1)\n");
	await t.cleanup();
});

test("empty list prints nothing", async () => {
	const t = await fresh();
	const { stdout } = await tasknote(t.cwd, "list");
	assert.equal(stdout, "");
	await t.cleanup();
});

test("done marks and prints", async () => {
	const t = await fresh();
	await tasknote(t.cwd, "add", "one");
	const { stdout } = await tasknote(t.cwd, "done", "1");
	assert.equal(stdout.trim(), "done #1");
	const data = JSON.parse(await readFile(join(t.cwd, ".tasknote.json"), "utf8"));
	assert.equal(data[0].done, true);
	await t.cleanup();
});

test("rm removes and prints", async () => {
	const t = await fresh();
	await tasknote(t.cwd, "add", "one");
	await tasknote(t.cwd, "add", "two");
	const { stdout } = await tasknote(t.cwd, "rm", "1");
	assert.equal(stdout.trim(), "removed #1");
	const data = JSON.parse(await readFile(join(t.cwd, ".tasknote.json"), "utf8"));
	assert.deepEqual(data.map((x) => x.id), [2]);
	await t.cleanup();
});

test("done unknown id fails on stderr with exit 1", async () => {
	const t = await fresh();
	await assert.rejects(
		tasknote(t.cwd, "done", "7"),
		/** @param {any} err */ (err) => err.code === 1 && /no task 7/.test(err.stderr),
	);
	await t.cleanup();
});

test("rm unknown id fails on stderr with exit 1", async () => {
	const t = await fresh();
	await assert.rejects(
		tasknote(t.cwd, "rm", "9"),
		/** @param {any} err */ (err) => err.code === 1 && /no task 9/.test(err.stderr),
	);
	await t.cleanup();
});

test("unknown command exits 1 with usage on stderr", async () => {
	const t = await fresh();
	await assert.rejects(
		tasknote(t.cwd, "frobnicate"),
		/** @param {any} err */ (err) => err.code === 1 && err.stderr.trim().length > 0,
	);
	await t.cleanup();
});

test("add without text exits 1", async () => {
	const t = await fresh();
	await assert.rejects(tasknote(t.cwd, "add"), (/** @type {any} */ err) => err.code === 1);
	await t.cleanup();
});

test("state persists across invocations", async () => {
	const t = await fresh();
	await tasknote(t.cwd, "add", "persist me");
	const { stdout } = await tasknote(t.cwd, "list");
	assert.match(stdout, /persist me/);
	await t.cleanup();
});

test("no flags after text are swallowed: text with spaces stays one task", async () => {
	const t = await fresh();
	const { stdout } = await tasknote(t.cwd, "add", "two words");
	assert.equal(stdout.trim(), "#1 two words");
	await t.cleanup();
});
