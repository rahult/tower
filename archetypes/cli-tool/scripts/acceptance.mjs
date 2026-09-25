#!/usr/bin/env node
// The acceptance runner. Runs every spec in acceptance/specs/ against the real binary and exits:
//   default        exit 0 iff every spec passes          (the green gate)
//   --expect-red   exit 0 iff every spec runs and fails  (the red gate — specs exist, behavior doesn't)
// On an incremental branch the red gate is scoped to the specs this branch adds or changes (the diff
// against the merge-base with the default branch); pre-existing specs report SKIP and never fail the
// red gate. A branch that adds no spec and commits acceptance/NO-NEW-BEHAVIOR declares itself
// behavior-less and is gated by unit tests plus the green gate instead.
// No specs at all fails both gates: an empty harness must never look like a pass.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const specsDir = join(root, "acceptance", "specs");
const expectRed = process.argv.includes("--expect-red");

const specFiles = existsSync(specsDir) ? readdirSync(specsDir).filter((file) => file.endsWith(".mjs")).sort() : [];
if (specFiles.length === 0) {
	console.error(`No acceptance specs in ${specsDir} — nothing to gate on.`);
	process.exit(1);
}

// The specs this branch is responsible for turning red: those it added or changed since the
// merge-base with the default branch. No git, no default branch, or no diff means old
// all-specs semantics only when there is no base to diff against at all.
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

const results = [];
for (const file of specFiles) {
	const spec = await import(pathToFileURL(join(specsDir, file)).href);
	const name = typeof spec.name === "string" ? spec.name : file;
	try {
		if (typeof spec.run !== "function") throw new Error("the spec does not export run()");
		await spec.run({ cli });
		results.push({ file, name, ok: true });
	} catch (error) {
		results.push({ file, name, ok: false, why: error instanceof Error ? error.message : String(error) });
	}
}

/** Runs the real binary: cli(["greet", "ada"]) → { status, stdout, stderr }. Each call gets a fresh
 *  throwaway working directory, so specs are isolated by default. */
function cli(args, cwd = mkdtempSync(join(tmpdir(), "cli-spec-"))) {
	const result = spawnSync(process.execPath, [join(root, "bin", "cli.js"), ...args], { encoding: "utf8", cwd });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", cwd };
}

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
		const marker = join(root, "acceptance", "NO-NEW-BEHAVIOR");
		if (existsSync(marker)) {
			console.log(`\nRED GATE N/A: no specs are new or changed and ${join("acceptance", "NO-NEW-BEHAVIOR")} declares this branch behavior-less (${readFileSync(marker, "utf8").trim().slice(0, 160)}). The green gate still gates every spec.`);
			process.exit(0);
		}
		console.error(`\nRED GATE FAILED: this branch changes no acceptance spec, so there is nothing to hold red. The build's specs must be added under acceptance/specs/, or a behavior-less branch must declare it in acceptance/NO-NEW-BEHAVIOR.`);
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
