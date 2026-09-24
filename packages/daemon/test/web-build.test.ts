import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWebDist, webDistIsStale } from "../src/web-build.ts";

// A fake checkout whose mtimes the tests set by hand, since staleness is decided entirely by timestamps.
function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "tower-webbuild-"));
	const webDir = join(root, "packages", "web");
	mkdirSync(join(webDir, "src"), { recursive: true });
	writeFileSync(join(webDir, "src", "App.tsx"), "export {}");
	writeFileSync(join(webDir, "index.html"), "<html></html>");
	writeFileSync(join(webDir, "vite.config.ts"), "export default {}");
	return root;
}

const touched = (path: string, msAgo: number) => utimesSync(path, new Date(Date.now() - msAgo), new Date(Date.now() - msAgo));
const build = (root: string) => {
	mkdirSync(join(root, "packages", "web", "dist"), { recursive: true });
	writeFileSync(join(root, "packages", "web", "dist", "index.html"), "<html>built</html>");
};

let root: string;

beforeEach(() => {
	root = makeRepo();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("webDistIsStale", () => {
	it("is stale when the dist has never been built", () => {
		expect(webDistIsStale(join(root, "packages", "web"), join(root, "packages", "web", "dist"))).toBe(true);
	});

	it("is fresh when the build postdates every source file", () => {
		build(root);
		touched(join(root, "packages", "web", "src", "App.tsx"), 120_000);
		touched(join(root, "packages", "web", "index.html"), 120_000);
		touched(join(root, "packages", "web", "vite.config.ts"), 120_000);
		touched(join(root, "packages", "web", "dist", "index.html"), 60_000);
		expect(webDistIsStale(join(root, "packages", "web"), join(root, "packages", "web", "dist"))).toBe(false);
	});

	it("is stale when a source file was touched after the last build — the git-pull case", () => {
		build(root);
		touched(join(root, "packages", "web", "dist", "index.html"), 120_000);
		touched(join(root, "packages", "web", "src", "App.tsx"), 60_000);
		expect(webDistIsStale(join(root, "packages", "web"), join(root, "packages", "web", "dist"))).toBe(true);
	});
});

describe("ensureWebDist", () => {
	it("builds when the dist is missing, through the injected runner", () => {
		const run = vi.fn(() => 0);
		expect(ensureWebDist(join(root, "packages", "web", "dist"), root, run)).toBe(true);
		expect(run).toHaveBeenCalledWith(root);
	});

	it("does nothing when the build is already fresh", () => {
		build(root);
		for (const file of [["src", "App.tsx"], ["index.html"], ["vite.config.ts"]].map((parts) => join(root, "packages", "web", ...parts))) touched(file, 120_000);
		touched(join(root, "packages", "web", "dist", "index.html"), 60_000);
		const run = vi.fn(() => 0);
		expect(ensureWebDist(join(root, "packages", "web", "dist"), root, run)).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it("rebuilds when the sources are newer than the dist", () => {
		build(root);
		touched(join(root, "packages", "web", "dist", "index.html"), 120_000);
		touched(join(root, "packages", "web", "src", "App.tsx"), 60_000);
		const run = vi.fn(() => 0);
		expect(ensureWebDist(join(root, "packages", "web", "dist"), root, run)).toBe(true);
	});

	it("leaves a custom TOWER_WEB_DIST alone, built or not", () => {
		const run = vi.fn(() => 0);
		expect(ensureWebDist(join(root, "elsewhere", "dist"), root, run)).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it("reports a failed build instead of throwing, so the daemon still starts", () => {
		const run = vi.fn(() => 1);
		expect(() => ensureWebDist(join(root, "packages", "web", "dist"), root, run)).not.toThrow();
		expect(console.error).toHaveBeenCalled();
	});
});
