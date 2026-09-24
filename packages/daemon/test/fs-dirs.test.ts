import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, byStage, type Harness } from "./harness.ts";

let h: Harness;
afterEach(async () => h?.close());

describe("the add-project directory picker", () => {
	it("lists a directory's subdirectories, flags the git repositories and skips hidden entries", async () => {
		h = await bootHarness(byStage());
		const root = join(h.home, "..", "browse");
		mkdirSync(join(root, "plain"), { recursive: true });
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		mkdirSync(join(root, ".secret"), { recursive: true });

		const res = await h.api("GET", `/api/fs/dirs?path=${encodeURIComponent(root)}`);
		expect(res.status).toBe(200);
		expect(res.body.path).toBe(resolve(root));
		expect(res.body.parent).toBe(resolve(root, ".."));
		expect(res.body.dirs).toEqual([
			{ name: "plain", path: join(resolve(root), "plain"), git: false },
			{ name: "repo", path: join(resolve(root), "repo"), git: true },
		]);
	});

	it("starts at the user's home directory and refuses paths that are not directories", async () => {
		h = await bootHarness(byStage());
		const home = await h.api("GET", "/api/fs/dirs");
		expect(home.status).toBe(200);
		expect(home.body.path).toBe(homedir());

		const file = join(h.home, "config.json");
		const bad = await h.api("GET", `/api/fs/dirs?path=${encodeURIComponent(file)}`);
		expect(bad.status).toBe(400);
		expect(bad.body.error).toContain("Not a directory");
	});
});
