#!/usr/bin/env node
// The acceptance runner. Boots the freshly built backend with a throwaway database, runs every spec
// in acceptance/specs/, prints a one line verdict per spec, and exits:
//   default        exit 0 iff every spec passes          (the green gate)
//   --expect-red   exit 0 iff every spec runs and fails  (the red gate — specs exist, behavior doesn't)
// On an incremental branch the red gate is scoped to the specs this branch adds or changes (the diff
// against the merge-base with the default branch): pre-existing specs legitimately pass, so they are
// reported as SKIP and never fail the red gate. The green gate always gates every spec.
// No specs at all fails both gates: an empty harness must never look like a pass.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const specsDir = join(root, "acceptance", "specs");
const expectRed = process.argv.includes("--expect-red");

const specFiles = existsSync(specsDir) ? readdirSync(specsDir).filter((file) => file.endsWith(".mjs")).sort() : [];
if (specFiles.length === 0) {
	console.error(`No acceptance specs in ${join(root, "acceptance", "specs")} — nothing to gate on.`);
	process.exit(1);
}

// The specs this branch is responsible for turning red: those it added or changed since the
// merge-base with the default branch. No git, no default branch, or a spec untouched by the
// branch means old all-specs semantics only when there is no base to diff against at all.
const git = (...args) => {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return null;
	}
};
const baseCommit = git("merge-base", "HEAD", "main") ?? git("merge-base", "HEAD", "master");
const ownSpecs = new Set();
if (baseCommit) {
	for (const path of git("diff", "--name-only", baseCommit, "HEAD").split("\n")) {
		if (path.startsWith("acceptance/specs/") && path.endsWith(".mjs")) ownSpecs.add(path.slice("acceptance/specs/".length));
	}
}

const dbFile = join(mkdtempSync(join(tmpdir(), "accept-")), "acceptance.sqlite");
const server = spawn(process.execPath, [join(root, "dist", "index.js")], {
	env: { ...process.env, PORT: "0", APP_DB: dbFile },
	stdio: ["ignore", "pipe", "inherit"],
});

let baseUrl;
try {
	baseUrl = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("the backend did not report a port within 15s")), 15_000);
		server.stdout.on("data", (chunk) => {
			const match = String(chunk).match(/listening on (\d+)/);
			if (match) {
				clearTimeout(timer);
				resolve(`http://127.0.0.1:${match[1]}`);
			}
		});
		server.on("exit", (code) => reject(new Error(`the backend exited early (${code})`)));
	});

	const results = [];
	for (const file of specFiles) {
		const spec = await import(pathToFileURL(join(specsDir, file)).href);
		const name = typeof spec.name === "string" ? spec.name : file;
		try {
			if (typeof spec.run !== "function") throw new Error("the spec does not export run()");
			await spec.run({ baseUrl, fetch });
			results.push({ file, name, ok: true });
		} catch (error) {
			results.push({ file, name, ok: false, why: error instanceof Error ? error.message : String(error) });
		}
	}

	server.kill();
	await new Promise((resolve) => server.on("exit", resolve));
	rmSync(dirname(dbFile), { recursive: true, force: true });

	const width = Math.max(...results.map((result) => result.name.length));
	for (const result of results) {
		const skipped = expectRed && baseCommit !== null && !ownSpecs.has(result.file);
		console.log(`${skipped ? "  SKIP" : result.ok ? "  PASS" : "  FAIL"}  ${result.name.padEnd(width)}${result.ok || skipped ? "" : ` — ${result.why}`}`);
	}
	const passed = results.filter((result) => result.ok).length;
	const red = expectRed ? `${passed}/${results.length} red` : `${passed}/${results.length} green`;

	if (expectRed) {
		const gated = baseCommit === null ? results : results.filter((result) => ownSpecs.has(result.file));
		const skipped = results.length - gated.length;
		if (gated.length === 0) {
			// A branch that adds no spec is a failing gate — unless it declares itself behavior-less:
			// hygiene and refactors have nothing to turn red, and the green gate plus verify gate them.
			const marker = join(root, "acceptance", "NO-NEW-BEHAVIOR");
			if (existsSync(marker)) {
				console.log(`\nRED GATE N/A: no specs are new or changed and ${join("acceptance", "NO-NEW-BEHAVIOR")} declares this branch behavior-less (${readFileSync(marker, "utf8").trim().slice(0, 160)}). The green gate still gates every spec.`);
				process.exit(0);
			}
			console.error(`\nRED GATE FAILED: this branch changes no acceptance spec, so there is nothing to hold red.${baseCommit ? " The build's specs must be added under acceptance/specs/, or a behavior-less branch must declare it in acceptance/NO-NEW-BEHAVIOR." : ""}`);
			process.exit(1);
		}
		const held = gated.filter((result) => result.ok);
		if (held.length > 0) {
			console.error(`\nRED GATE FAILED: ${red} (of ${gated.length} gated). These specs already pass — the behavior exists before the build did:\n${held.map((result) => `  - ${result.name}`).join("\n")}`);
			process.exit(1);
		}
		console.log(`\nRED GATE OK: ${gated.length}/${gated.length} red${skipped > 0 ? `, ${skipped} pre-existing skipped` : ""}. Every gated spec fails for the right reason — the build's job is to turn them green.`);
		process.exit(0);
	}
	if (passed < results.length) {
		console.error(`\nGREEN GATE FAILED: ${red}.`);
		process.exit(1);
	}
	console.log(`\nGREEN GATE OK: ${red}.`);
	process.exit(0);
} catch (error) {
	server.kill();
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
