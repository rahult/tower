// Hidden acceptance tests for the kvstore task.
// Usage: node kvstore.acceptance.test.mjs <target-dir>
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: node kvstore.acceptance.test.mjs <target-dir>");
	process.exit(2);
}
const { openStore } = await import(pathToFileURL(join(dir, "src", "index.js")).href);

let storeDir;
test("setup scratch dir", async () => {
	storeDir = await mkdtemp(join(tmpdir(), "kv-accept-"));
});

const p = (name) => join(storeDir, name);

test("get on missing key returns undefined", () => {
	const store = openStore(p("missing.json"));
	assert.equal(store.get("nope"), undefined);
});

test("set/get round-trips deep JSON values", () => {
	const store = openStore(p("roundtrip.json"));
	const value = { nested: { list: [1, "two", { three: null }] }, n: 7, s: "x", b: false, nil: null };
	store.set("k", value);
	assert.deepEqual(store.get("k"), value);
});

test("get returns a deep copy, not a live reference", () => {
	const store = openStore(p("copy.json"));
	store.set("k", { count: 1 });
	const got = store.get("k");
	got.count = 999;
	got.nested = { hacked: true };
	assert.deepEqual(store.get("k"), { count: 1 });
});

test("del reports existence and removes", () => {
	const store = openStore(p("del.json"));
	store.set("a", 1);
	assert.equal(store.del("a"), true);
	assert.equal(store.del("a"), false);
	assert.equal(store.get("a"), undefined);
});

test("non-string keys throw TypeError on all ops", () => {
	const store = openStore(p("keys.json"));
	for (const bad of [1, null, {}, ["x"], true]) {
		assert.throws(() => store.get(bad), TypeError);
		assert.throws(() => store.set(bad, 1), TypeError);
		assert.throws(() => store.del(bad), TypeError);
	}
	store.set("ok", 1);
	assert.equal(store.get("ok"), 1);
});

test("non-serializable values throw TypeError on set", () => {
	const store = openStore(p("vals.json"));
	assert.throws(() => store.set("f", () => {}), TypeError);
	assert.throws(() => store.set("u", undefined), TypeError);
	const circular = {};
	circular.me = circular;
	assert.throws(() => store.set("c", circular), TypeError);
});

test("last set wins", () => {
	const store = openStore(p("wins.json"));
	store.set("k", 1);
	store.set("k", 2);
	assert.equal(store.get("k"), 2);
});

test("transaction commits all changes", () => {
	const store = openStore(p("txcommit.json"));
	store.set("base", 1);
	store.transaction((tx) => {
		tx.set("a", "new");
		tx.set("base", 2);
		tx.del("gone" in store ? "gone" : "never-there");
	});
	assert.equal(store.get("a"), "new");
	assert.equal(store.get("base"), 2);
});

test("transaction sees its own writes", () => {
	const store = openStore(p("txsee.json"));
	let seen;
	store.transaction((tx) => {
		tx.set("x", 42);
		seen = tx.get("x");
	});
	assert.equal(seen, 42);
});

test("throwing transaction rolls back everything", () => {
	const store = openStore(p("txrollback.json"));
	store.set("existing", "original");
	assert.throws(
		() =>
			store.transaction((tx) => {
				tx.set("existing", "clobbered");
				tx.set("fresh", "value");
				tx.del("existing");
				throw new Error("abort");
			}),
		/abort/,
	);
	assert.equal(store.get("existing"), "original");
	assert.equal(store.get("fresh"), undefined);
});

test("rollback restores values changed mid-transaction", () => {
	const store = openStore(p("txrestore.json"));
	store.set("n", 10);
	try {
		store.transaction((tx) => {
			tx.set("n", 11);
			throw new Error("nope");
		});
	} catch {}
	assert.equal(store.get("n"), 10);
});

test("nested transaction throws TypeError", () => {
	const store = openStore(p("txnested.json"));
	assert.throws(
		() =>
			store.transaction(() => {
				store.transaction(() => {});
			}),
		TypeError,
	);
});

test("committed changes survive reopen without close (crash)", () => {
	const path = p("crash.json");
	const store = openStore(path);
	store.set("a", { deep: [1, 2] });
	store.set("b", 2);
	store.del("b");
	// no close(): simulated crash
	const reopened = openStore(path);
	assert.deepEqual(reopened.get("a"), { deep: [1, 2] });
	assert.equal(reopened.get("b"), undefined);
});

test("transaction effects survive crash", () => {
	const path = p("txcrash.json");
	const store = openStore(path);
	store.transaction((tx) => {
		tx.set("t1", 1);
		tx.set("t2", 2);
	});
	// crash: reopen without close
	const reopened = openStore(path);
	assert.equal(reopened.get("t1"), 1);
	assert.equal(reopened.get("t2"), 2);
});

test("rolled-back transaction leaves nothing after crash", () => {
	const path = p("rollbackcrash.json");
	const store = openStore(path);
	try {
		store.transaction((tx) => {
			tx.set("phantom", 1);
			throw new Error("x");
		});
	} catch {}
	const reopened = openStore(path); // WAL must contain no trace of the phantom
	assert.equal(reopened.get("phantom"), undefined);
});

test("close then reopen preserves everything", () => {
	const path = p("close.json");
	const store = openStore(path);
	store.set("kept", [1, 2, 3]);
	store.set("removed", "x");
	store.del("removed");
	if (typeof store.close === "function") store.close();
	const reopened = openStore(path);
	assert.deepEqual(reopened.get("kept"), [1, 2, 3]);
	assert.equal(reopened.get("removed"), undefined);
});

test("teardown", async () => {
	await rm(storeDir, { recursive: true, force: true });
});
