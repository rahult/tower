import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Reply } from "../app.ts";
import { Db } from "../db.ts";

describe("the API", () => {
	let base: string;
	let server: ReturnType<typeof createApp>;
	let db: Db;

	beforeAll(async () => {
		db = new Db(join(mkdtempSync(join(tmpdir(), "app-test-")), "test.sqlite"));
		server = createApp(db);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	afterAll(() => server.close());

	const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
		const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await response.text();
		return { status: response.status, body: text === "" ? null : JSON.parse(text) };
	};

	it("answers its health check", async () => {
		const reply = await call("GET", "/api/health");
		expect(reply).toEqual({ status: 200, body: { ok: true } });
	});

	it("creates, lists and deletes notes", async () => {
		const created = await call("POST", "/api/notes", { body: "milk" });
		expect(created.status).toBe(201);
		const list = await call("GET", "/api/notes");
		expect(list.body).toEqual([created.body]);
		expect(await call("DELETE", `/api/notes/${(created.body as { id: number }).id}`)).toEqual({ status: 204, body: null } satisfies Reply);
		expect(await call("GET", "/api/notes")).toEqual({ status: 200, body: [] });
	});

	it("refuses a duplicate note", async () => {
		await call("POST", "/api/notes", { body: "eggs" });
		expect((await call("POST", "/api/notes", { body: "eggs" })).status).toBe(409);
	});

	it("validates at the boundary", async () => {
		expect((await call("POST", "/api/notes", { body: "" })).status).toBe(400);
		expect((await call("POST", "/api/notes", { body: 42 })).status).toBe(400);
		expect((await call("POST", "/api/notes", {})).status).toBe(400);
	});

	it("answers 404 for unknown routes and unknown notes", async () => {
		expect((await call("GET", "/api/nope")).status).toBe(404);
		expect((await call("DELETE", "/api/notes/99999")).status).toBe(404);
	});
});
