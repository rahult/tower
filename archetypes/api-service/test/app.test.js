import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";

let server;
let baseUrl;
let store;

beforeAll(async () => {
	store = new Store(join(mkdtempSync(join(tmpdir(), "api-test-")), "test.sqlite"));
	server = createApp(store);
	await new Promise((resolve) => server.listen(0, resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
	server.close();
	store.close();
});

const call = async (method, path, body) => {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
};

describe("the items API", () => {
	it("reports health", async () => {
		const response = await call("GET", "/api/health");
		expect(response).toMatchObject({ status: 200, body: { ok: true } });
	});

	it("creates an item and lists it", async () => {
		const created = await call("POST", "/api/items", { name: "first" });
		expect(created.status).toBe(201);
		const list = await call("GET", "/api/items");
		expect(list.body.some((item) => item.name === "first")).toBe(true);
	});

	it("validates at the boundary: empty, long and malformed names are 400s", async () => {
		expect((await call("POST", "/api/items", { name: "" })).status).toBe(400);
		expect((await call("POST", "/api/items", { name: "x".repeat(121) })).status).toBe(400);
		expect((await call("POST", "/api/items", { name: 7 })).status).toBe(400);
		expect((await call("POST", "/api/items", "not json object")).status).toBe(400);
	});

	it("answers unknown routes with a 404 and non-JSON bodies with a 400, never a hang", async () => {
		expect((await call("GET", "/api/nope")).status).toBe(404);
		const bad = await fetch(`${baseUrl}/api/items`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
		expect(bad.status).toBe(400);
	});
});
