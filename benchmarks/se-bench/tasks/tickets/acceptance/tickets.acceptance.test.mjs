// Hidden acceptance tests for the tickets task.
// Usage: node tickets.acceptance.test.mjs <target-dir>
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: node tickets.acceptance.test.mjs <target-dir>");
	process.exit(2);
}
const { openTickets } = await import(pathToFileURL(join(dir, "src", "index.js")).href);

let workDir;
test("setup scratch dir", async () => {
	workDir = await mkdtemp(join(tmpdir(), "tickets-accept-"));
});

const p = (name) => join(workDir, name);
const isoOk = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));

test("create returns a well-formed open ticket", () => {
	const store = openTickets(p("basic.json"));
	const t = store.create({ title: "First bug" });
	assert.equal(t.id, 1);
	assert.equal(t.title, "First bug");
	assert.equal(t.status, "open");
	assert.equal(t.priority, "medium");
	assert.equal(t.assignee, null);
	assert.deepEqual(t.comments, []);
	assert.ok(isoOk(t.createdAt));
});

test("ids increase and are never reused", () => {
	const store = openTickets(p("ids.json"));
	assert.equal(store.create({ title: "a" }).id, 1);
	assert.equal(store.create({ title: "b" }).id, 2);
});

test("create validates title and priority", () => {
	const store = openTickets(p("createval.json"));
	assert.throws(() => store.create({ title: "" }), TypeError);
	assert.throws(() => store.create({ title: 42 }), TypeError);
	assert.throws(() => store.create({ title: "x", priority: "urgent" }), TypeError);
	const t = store.create({ title: "x", priority: "high", assignee: "sam" });
	assert.equal(t.priority, "high");
	assert.equal(t.assignee, "sam");
});

test("get returns ticket or undefined; validates id type", () => {
	const store = openTickets(p("get.json"));
	const t = store.create({ title: "t" });
	assert.equal(store.get(t.id).title, "t");
	assert.equal(store.get(999), undefined);
	assert.throws(() => store.get("1"), TypeError);
});

test("workflow: start, close, reopen", () => {
	const store = openTickets(p("flow.json"));
	const t = store.create({ title: "wf" });
	assert.equal(store.transition(t.id, "start").status, "in_progress");
	assert.equal(store.transition(t.id, "close").status, "closed");
	assert.equal(store.transition(t.id, "reopen").status, "open");
});

test("workflow: close from open is allowed", () => {
	const store = openTickets(p("flow2.json"));
	const t = store.create({ title: "direct" });
	assert.equal(store.transition(t.id, "close").status, "closed");
});

test("invalid transitions throw with the exact message", () => {
	const store = openTickets(p("badflow.json"));
	const t = store.create({ title: "x" });
	assert.throws(() => store.transition(t.id, "start") && store.transition(t.id, "start"), /invalid transition/);
	const t2 = store.create({ title: "y" });
	assert.throws(() => store.transition(t2.id, "close") && store.transition(t2.id, "close"), /invalid transition: closed -> close/);
	assert.throws(() => store.transition(t.id, "reopen"), /invalid transition: in_progress -> reopen/);
	const t3 = store.create({ title: "z" });
	assert.throws(() => store.transition(t3.id, "reopen"), /invalid transition: open -> reopen/);
	assert.throws(() => store.transition(999, "start"), RangeError);
});

test("update changes fields with validation", () => {
	const store = openTickets(p("update.json"));
	const t = store.create({ title: "old" });
	const u = store.update(t.id, { title: "new", priority: "low", assignee: "kim", bogus: 1 });
	assert.equal(u.title, "new");
	assert.equal(u.priority, "low");
	assert.equal(u.assignee, "kim");
	assert.equal("bogus" in u, false);
	assert.throws(() => store.update(t.id, { priority: "x" }), TypeError);
	assert.throws(() => store.update(t.id, { title: "" }), TypeError);
	assert.throws(() => store.update(999, { title: "z" }), RangeError);
});

test("comment appends with ISO timestamp and validation", () => {
	const store = openTickets(p("comment.json"));
	const t = store.create({ title: "c" });
	const after = store.comment(t.id, "looking into it");
	assert.equal(after.comments.length, 1);
	assert.equal(after.comments[0].body, "looking into it");
	assert.ok(isoOk(after.comments[0].at));
	assert.ok(Date.parse(after.comments[0].at) >= Date.parse(after.createdAt));
	assert.throws(() => store.comment(t.id, ""), TypeError);
	assert.throws(() => store.comment(999, "hi"), RangeError);
});

test("list is id-ordered and filters by status and assignee", () => {
	const store = openTickets(p("list.json"));
	const a = store.create({ title: "a", assignee: "sam" });
	const b = store.create({ title: "b" });
	store.create({ title: "c", assignee: "sam" });
	store.transition(a.id, "start");
	const all = store.list();
	assert.deepEqual(all.map((t) => t.id), [1, 2, 3]);
	assert.deepEqual(store.list({ status: "in_progress" }).map((t) => t.id), [a.id]);
	assert.deepEqual(store.list({ status: "closed" }), []);
	assert.deepEqual(store.list({ assignee: "sam" }).map((t) => t.id), [a.id, a.id + 2]);
	assert.deepEqual(store.list({ status: "nope" }), []);
	assert.deepEqual(store.list({ status: "open", assignee: "sam" }).map((t) => t.id), [a.id + 2]);
});

test("persistence across instances without close", () => {
	const path = p("persist.json");
	const store = openTickets(path);
	const t = store.create({ title: "keep", priority: "high" });
	store.transition(t.id, "start");
	store.comment(t.id, "note");
	const reopened = openTickets(path);
	const got = reopened.get(1);
	assert.equal(got.title, "keep");
	assert.equal(got.status, "in_progress");
	assert.equal(got.comments.length, 1);
	assert.equal(reopened.create({ title: "next" }).id, 2);
});

test("tickets are independent between two store files", () => {
	const s1 = openTickets(p("a.json"));
	const s2 = openTickets(p("b.json"));
	s1.create({ title: "one" });
	assert.equal(s2.list().length, 0);
});

test("timestamps are monotonic across creates", () => {
	const store = openTickets(p("time.json"));
	const t1 = store.create({ title: "1" });
	const t2 = store.create({ title: "2" });
	assert.ok(Date.parse(t2.createdAt) >= Date.parse(t1.createdAt));
});

test("teardown", async () => {
	await rm(workDir, { recursive: true, force: true });
});
