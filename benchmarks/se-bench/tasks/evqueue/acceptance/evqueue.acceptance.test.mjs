// Hidden acceptance tests for the evqueue task.
// Usage: node evqueue.acceptance.test.mjs <target-dir>
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: node evqueue.acceptance.test.mjs <target-dir>");
	process.exit(2);
}
const { openQueue } = await import(pathToFileURL(join(dir, "src", "index.js")).href);

let queueDir;
test("setup scratch dir", async () => {
	queueDir = await mkdtemp(join(tmpdir(), "evq-accept-"));
});

const q = (name) => join(queueDir, name);

test("enqueue returns increasing ids from 1", () => {
	const queue = openQueue(q("ids.json"));
	assert.equal(queue.enqueue("a"), 1);
	assert.equal(queue.enqueue("b"), 2);
	assert.equal(queue.enqueue("c"), 3);
});

test("dequeue is FIFO with attempts starting at 0", () => {
	const queue = openQueue(q("fifo.json"));
	queue.enqueue("first");
	queue.enqueue("second");
	assert.deepEqual(queue.dequeue(), { id: 1, payload: "first", attempts: 0 });
	assert.deepEqual(queue.dequeue(), { id: 2, payload: "second", attempts: 0 });
});

test("dequeue on empty queue returns null", () => {
	const queue = openQueue(q("empty.json"));
	assert.equal(queue.dequeue(), null);
});

test("dequeue does not redeliver in-flight messages", () => {
	const queue = openQueue(q("inflight.json"));
	queue.enqueue("only");
	queue.dequeue();
	assert.equal(queue.dequeue(), null);
});

test("ack removes the message permanently", () => {
	const queue = openQueue(q("ack.json"));
	queue.enqueue("x");
	queue.enqueue("y");
	const msg = queue.dequeue();
	queue.ack(msg.id);
	assert.deepEqual(queue.dequeue(), { id: 2, payload: "y", attempts: 0 });
	assert.equal(queue.dequeue(), null);
});

test("ack of unknown id throws RangeError", () => {
	const queue = openQueue(q("ackerr.json"));
	queue.enqueue("x");
	assert.throws(() => queue.ack(999), RangeError);
	assert.throws(() => queue.ack(1), RangeError); // not in-flight yet
});

test("nack requeues with attempts incremented", () => {
	const queue = openQueue(q("nack.json"));
	queue.enqueue("m");
	const msg = queue.dequeue();
	assert.equal(msg.attempts, 0);
	queue.nack(msg.id);
	assert.deepEqual(queue.dequeue(), { id: 1, payload: "m", attempts: 1 });
});

test("third nack dead-letters the message at attempts 3", () => {
	const queue = openQueue(q("dead.json"));
	queue.enqueue("poison");
	let msg = queue.dequeue();
	queue.nack(msg.id); // attempts 1
	msg = queue.dequeue();
	queue.nack(msg.id); // attempts 2
	msg = queue.dequeue();
	assert.equal(msg.attempts, 2);
	queue.nack(msg.id); // attempts 3 -> dead
	assert.equal(queue.dequeue(), null);
	assert.deepEqual(queue.dead(), [{ id: 1, payload: "poison", attempts: 3 }]);
	assert.throws(() => queue.ack(1), RangeError); // dead, not in-flight
});

test("nacked message resumes FIFO by id", () => {
	const queue = openQueue(q("order.json"));
	queue.enqueue("a");
	queue.enqueue("b");
	const first = queue.dequeue();
	queue.nack(first.id);
	assert.deepEqual(queue.dequeue(), { id: 1, payload: "a", attempts: 1 });
	assert.deepEqual(queue.dequeue(), { id: 2, payload: "b", attempts: 0 });
});

test("state persists across reopen without close", () => {
	const path = q("persist.json");
	const queue = openQueue(path);
	queue.enqueue("keep");
	queue.enqueue("drop");
	queue.dequeue(); // id1 in-flight
	queue.ack(1); // remove
	// no close(): simulate crash by simply opening a new instance
	const reopened = openQueue(path);
	assert.deepEqual(reopened.dequeue(), { id: 2, payload: "drop", attempts: 0 });
	assert.equal(reopened.dequeue(), null);
});

test("in-flight messages become available on reopen", () => {
	const path = q("recovery.json");
	const queue = openQueue(path);
	queue.enqueue("deliver-me");
	queue.dequeue(); // never acked -> crash
	const reopened = openQueue(path);
	assert.deepEqual(reopened.dequeue(), { id: 1, payload: "deliver-me", attempts: 0 });
});

test("ids never reused across reopen", () => {
	const path = q("monotonic.json");
	const queue = openQueue(path);
	queue.enqueue("one");
	openQueue(path); // reopen
	const again = openQueue(path);
	assert.equal(again.enqueue("two"), 2);
});

test("payloads round-trip through JSON", () => {
	const path = q("json.json");
	const payloads = [{ a: [1, 2, { b: null }] }, [1, "two", true], 42, "str", false, null];
	const queue = openQueue(path);
	for (const p of payloads) queue.enqueue(p);
	const reopened = openQueue(path);
	for (const p of payloads) {
		const msg = reopened.dequeue();
		assert.equal(msg.id >= 1, true);
		assert.deepEqual(msg.payload, p);
	}
});

test("non-serializable payloads throw TypeError", () => {
	const queue = openQueue(q("typeerr.json"));
	assert.throws(() => queue.enqueue(() => {}), TypeError);
	assert.throws(() => queue.enqueue(undefined), TypeError);
	const circular = {};
	circular.self = circular;
	assert.throws(() => queue.enqueue(circular), TypeError);
});

test("fresh queue has empty dead list", () => {
	const queue = openQueue(q("fresh.json"));
	assert.deepEqual(queue.dead(), []);
});

test("dead-lettered message does not block later messages", () => {
	const queue = openQueue(q("flow.json"));
	queue.enqueue("bad");
	queue.enqueue("good");
	for (let i = 0; i < 3; i++) queue.nack(queue.dequeue().id); // kill id1
	assert.equal(queue.dead().length, 1);
	assert.deepEqual(queue.dequeue(), { id: 2, payload: "good", attempts: 0 });
});

test("teardown", async () => {
	await rm(queueDir, { recursive: true, force: true });
});
