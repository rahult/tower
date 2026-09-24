import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Newest mtime anywhere under a path; a missing path counts as never touched. */
function newestMtime(path: string): number {
	if (!existsSync(path)) return 0;
	const stats = statSync(path);
	if (!stats.isDirectory()) return stats.mtimeMs;
	return readdirSync(path, { withFileTypes: true }).reduce((max, entry) => Math.max(max, newestMtime(join(path, entry.name))), 0);
}

/** True when the built UI is absent or predates a change to the web sources, so serving it would show an old board. */
export function webDistIsStale(webDir: string, webDist: string): boolean {
	const sources = ["src", "index.html", "vite.config.ts", "package.json"].map((name) => newestMtime(join(webDir, name)));
	return Math.max(...sources) > newestMtime(join(webDist, "index.html"));
}

/** Runs the real build, streaming its output; returns the exit status, or -1 when pnpm itself could not run. */
function runPnpmBuild(repoRoot: string): number {
	const build = spawnSync("pnpm", ["-C", "packages/web", "build"], { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });
	return build.error ? -1 : build.status ?? -1;
}

/**
 * Builds the web UI at startup when it is missing or stale: dist is gitignored, so `git pull && pnpm start` on
 * another machine would otherwise serve a 404 until someone builds by hand. A custom TOWER_WEB_DIST is left
 * alone — whoever points the daemon elsewhere owns building there.
 */
export function ensureWebDist(webDist: string, repoRoot: string, run: (repoRoot: string) => number = runPnpmBuild): boolean {
	if (webDist !== join(repoRoot, "packages", "web", "dist")) return false;
	const reason = !existsSync(join(webDist, "index.html")) ? "not built" : webDistIsStale(join(repoRoot, "packages", "web"), webDist) ? "older than the web sources" : null;
	if (!reason) return false;
	console.log(`web UI is ${reason} — building it (pnpm -C packages/web build)…`);
	if (run(repoRoot) !== 0) console.error("web build failed; the daemon still starts, but the board will 404 until `pnpm -C packages/web build` succeeds");
	return true;
}
