// Hidden acceptance tests for the webnote task.
// Usage: node webnote.acceptance.test.mjs <target-dir>
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: node webnote.acceptance.test.mjs <target-dir>");
	process.exit(2);
}

let workDir;
let nextPort = 41000 + Math.floor(Math.random() * 2000);
let bootCount = 0;

async function boot(t, notesName) {
	notesName = notesName || `notes-${++bootCount}.json`;
	const port = nextPort++;
	const notesFile = join(workDir, notesName);
	const child = spawn(process.execPath, [join(dir, "src", "server.js")], {
		env: { ...process.env, PORT: String(port), NOTES_FILE: notesFile },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (c) => (stderr += c));
	t.after(() => {
		child.kill("SIGKILL");
	});
	// Wait until the server answers (or exit).
	const deadline = Date.now() + 8000;
	for (;;) {
		if (child.exitCode !== null) throw new Error(`server exited immediately (code ${child.exitCode}): ${stderr.slice(0, 300)}`);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/notes`);
			if (res.ok) return { port, notesFile, child };
		} catch {}
		if (Date.now() > deadline) throw new Error(`server did not start listening within 8s: ${stderr.slice(0, 300)}`);
		await new Promise((r) => setTimeout(r, 120));
	}
}

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`);
const post = (port, path, body) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const del = (port, path) => fetch(`http://127.0.0.1:${port}${path}`, { method: "DELETE" });

test("setup scratch dir", async () => {
	workDir = await mkdtemp(join(tmpdir(), "webnote-accept-"));
});

test("serves a self-contained page at /", async (t) => {
	const { port } = await boot(t);
	const res = await get(port, "/");
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type") ?? "", /text\/html/);
	const html = await res.text();
	assert.match(html, /<div id="app">/);
	assert.doesNotMatch(html, /src\s*=\s*["']https?:\/\//);
	assert.doesNotMatch(html, /href\s*=\s*["']https?:\/\//);
	assert.doesNotMatch(html, /src\s*=\s*["']\/\//);
	assert.doesNotMatch(html, /href\s*=\s*["']\/\//);
});

test("notes API starts empty", async (t) => {
	const { port } = await boot(t);
	const res = await get(port, "/api/notes");
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type") ?? "", /json/);
	assert.deepEqual(await res.json(), { notes: [] });
});

test("create, read, delete with exact contracts", async (t) => {
	const { port } = await boot(t);
	const created = await post(port, "/api/notes", { text: "first" });
	assert.equal(created.status, 201);
	const body = await created.json();
	assert.equal(body.note.id, 1);
	assert.equal(body.note.text, "first");
	assert.ok(!Number.isNaN(Date.parse(body.note.createdAt)));

	const list = await (await get(port, "/api/notes")).json();
	assert.equal(list.notes.length, 1);

	const gone = await del(port, "/api/notes/1");
	assert.equal(gone.status, 204);
	assert.deepEqual(await (await get(port, "/api/notes")).json(), { notes: [] });

	const again = await del(port, "/api/notes/1");
	assert.equal(again.status, 404);
	assert.equal((await again.json()).error, "no note with id 1");
});

test("ids increase and are never reused", async (t) => {
	const { port } = await boot(t);
	for (const text of ["a", "b", "c"]) await post(port, "/api/notes", { text });
	const list = await (await get(port, "/api/notes")).json();
	assert.deepEqual(list.notes.map((n) => n.id), [1, 2, 3]);
	await del(port, "/api/notes/2");
	const d = await post(port, "/api/notes", { text: "d" });
	assert.equal((await d.json()).note.id, 4);
	const final = await (await get(port, "/api/notes")).json();
	assert.deepEqual(final.notes.map((n) => n.id), [1, 3, 4]);
});

test("validation errors are 400 with the exact message", async (t) => {
	const { port } = await boot(t);
	for (const bad of [{}, { text: "" }, { text: "   " }, { text: 42 }, "raw"]) {
		const res = await post(port, "/api/notes", bad);
		assert.equal(res.status, 400, JSON.stringify(bad));
		assert.equal((await res.json()).error, "text must be a non-empty string");
	}
});

test("malformed JSON body returns 400, server survives", async (t) => {
	const { port } = await boot(t);
	const res = await fetch(`http://127.0.0.1:${port}/api/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
	assert.equal(res.status, 400);
	assert.equal((await get(port, "/api/notes")).status, 200);
});

test("unknown paths 404 as JSON", async (t) => {
	const { port } = await boot(t);
	const res = await get(port, "/nope");
	assert.equal(res.status, 404);
	assert.equal((await res.json()).error, "not found");
});

test("notes survive a restart", async (t) => {
	const first = await boot(t, "persist.json");
	await post(first.port, "/api/notes", { text: "keep me" });
	await post(first.port, "/api/notes", { text: "and me" });
	first.child.kill("SIGKILL");
	// restart on the same file
	const second = await boot(t, "persist.json");
	const list = await (await get(second.port, "/api/notes")).json();
	assert.deepEqual(list.notes.map((n) => n.text), ["keep me", "and me"]);
});

test("package.json has no dependencies and npm start works", async (t) => {
	const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, "must have zero dependencies");
	assert.equal(typeof pkg.scripts?.start, "string");
	const { port } = await boot(t);
	assert.equal((await get(port, "/")).status, 200);
});

test("teardown", async () => {
	await rm(workDir, { recursive: true, force: true });
});
