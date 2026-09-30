/** Task registry: briefs, repo templates, hidden acceptance tests. */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { run } from "./shell.ts";

export interface TaskDef {
	id: string;
	title: string;
	/** One line the judge sees as "what was asked". */
	summary: string;
	acceptanceTest: string;
}

export const TASKS: TaskDef[] = [
	{ id: "sluglib", title: "Build sluglib", summary: "a slugify string library with unicode folding, separators and maxLength", acceptanceTest: "sluglib.acceptance.test.mjs" },
	{ id: "tasknote", title: "Build tasknote CLI", summary: "a JSON-file-backed todo CLI with exact output formats and exit codes", acceptanceTest: "tasknote.acceptance.test.mjs" },
	{ id: "propsheet", title: "Build propsheet", summary: "an INI-style config parser with typed values, quoting and a stringify round-trip", acceptanceTest: "propsheet.acceptance.test.mjs" },
	{ id: "evqueue", title: "Build evqueue", summary: "a durable FIFO event queue with ack/nack retry, dead-lettering, and at-least-once recovery", acceptanceTest: "evqueue.acceptance.test.mjs" },
	{ id: "kvstore", title: "Build kvstore", summary: "a transactional key-value store with atomic rollback and WAL crash recovery", acceptanceTest: "kvstore.acceptance.test.mjs" },
	{ id: "webnote", title: "Build webnote", summary: "a self-contained notes web app: zero-dependency HTTP server, offline single-page UI, JSON CRUD API with exact contracts, and restart-safe file persistence", acceptanceTest: "webnote.acceptance.test.mjs" },
	{ id: "tickets", title: "Build a ticket system", summary: "a JSON-persisted ticket tracker with a status workflow (start/close/reopen), comments, assignment, priorities, and filtering", acceptanceTest: "tickets.acceptance.test.mjs" },
];

export function taskDir(taskId: string): string {
	return join(import.meta.dirname, "..", "tasks", taskId);
}

export async function readBrief(taskId: string): Promise<string> {
	return readFile(join(taskDir(taskId), "brief.md"), "utf8");
}

/** Fresh start dir with the template files, no git (the raw/basic arms do not need history). */
export async function prepareStartDir(taskId: string, target: string): Promise<string> {
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	await cp(join(taskDir(taskId), "repo-template"), target, { recursive: true });
	await mkdir(join(target, "src"), { recursive: true });
	await mkdir(join(target, "test"), { recursive: true });
	await writeFile(join(target, "src", ".gitkeep"), "");
	await writeFile(join(target, "test", ".gitkeep"), "");
	return target;
}

/** Git repo from the template, one initial commit on main — the starting point a Tower project points at. */
export async function prepareRepo(taskId: string, target: string): Promise<string> {
	await prepareStartDir(taskId, target);
	await run("git", ["init", "-b", "main", "."], target);
	await run("git", ["add", "-A"], target);
	await run("git", ["-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-m", "Template", "."], target);
	return target;
}

/** Recursively lists files under dir, skipping noise. Paths are relative, sorted. */
export async function listFiles(dir: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
		else out.push(rel);
	}
	return out;
}

export interface FileBundle {
	path: string;
	content: string;
}

export async function readAllFiles(dir: string, maxBytesPerFile = 24_000): Promise<FileBundle[]> {
	const paths = await listFiles(dir);
	const out: FileBundle[] = [];
	for (const path of paths) {
		if (path.endsWith(".gitkeep")) continue;
		const full = join(dir, path);
		let content = await readFile(full, "utf8");
		if (Buffer.byteLength(content) > maxBytesPerFile) content = `${content.slice(0, maxBytesPerFile)}\n… [truncated]`;
		out.push({ path, content });
	}
	return out;
}

/** Runs the hidden acceptance suite against a produced directory. */
export interface AcceptanceResult {
	total: number;
	passed: number;
	failed: number;
	cases: Array<{ name: string; status: "pass" | "fail"; message: string | null }>;
	raw: string;
}

export async function runAcceptance(taskId: string, targetDir: string): Promise<AcceptanceResult> {
	const test = join(taskDir(taskId), "acceptance", TASKS.find((t) => t.id === taskId)!.acceptanceTest);
	const proc = await run(process.execPath, [test, resolve(targetDir)], taskDir(taskId), 300_000);
	return parseNodeTestOutput(proc.stdout + proc.stderr, proc.stdout + proc.stderr);
}

/** Parses node:test output: the spec reporter (✔/✖) when run as main, TAP when run via --test. */
export function parseNodeTestOutput(output: string, raw: string): AcceptanceResult {
	const cases: AcceptanceResult["cases"] = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const specPass = line.match(/^✔\s+(.+?)(?:\s*\(\d[\d.]*ms\))?$/);
		const specFail = line.match(/^✖\s+(.+?)(?:\s*\(\d[\d.]*ms\))?$/);
		const tapPass = line.match(/^ok \d+ (?:- )?(.*)$/);
		const tapFail = line.match(/^not ok \d+ (?:- )?(.*)$/);
		const pass = specPass ?? tapPass;
		const fail = specFail ?? tapFail;
		if (pass) {
			cases.push({ name: cleanTestName(pass[1]), status: "pass", message: null });
		} else if (fail) {
			const name = cleanTestName(fail[1]);
			let message: string | null = null;
			for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
				const m = lines[j].match(/^\s+error:\s+(.*)$/i) ?? lines[j].match(/^\s+message:\s+'?(.*?)'?$/);
				if (m) {
					message = m[1].slice(0, 300);
					break;
				}
			}
			cases.push({ name, status: "fail", message });
		}
	}
	const seen = new Set<string>();
	const unique = cases.filter((c) => {
		if (seen.has(c.name) || c.name === "failing tests:") return false;
		seen.add(c.name);
		return true;
	});
	const passed = unique.filter((c) => c.status === "pass").length;
	return { total: unique.length, passed, failed: unique.length - passed, cases: unique, raw: raw.slice(-8000) };
}

function cleanTestName(name: string): string {
	return name.replace(/\s*# SUBTEST.*$/, "").trim();
}

/** Runs the produced project's own test script, if any. */
export interface OwnTestResult {
	hasTests: boolean;
	passed: boolean;
	detail: string;
	testFileCount: number;
}

export async function runOwnTests(dir: string): Promise<OwnTestResult> {
	let pkg: any = {};
	try {
		pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	} catch {
		return { hasTests: false, passed: false, detail: "no readable package.json", testFileCount: 0 };
	}
	const files = await listFiles(dir);
	// node's runner runs every .js/.mjs/.cjs file under a test-ish directory, plus *.test.* anywhere.
	const testFiles = files.filter(
		(f) => /(^|\/)(tests?|__tests__|spec)\/[^/]+\.[cm]?js$/.test(f) || /\.test\.[cm]?js$/.test(f) || /(^|\/)test\.[cm]?js$/.test(f),
	);
	const hasRealTests = testFiles.length > 0;
	if (!pkg.scripts?.test) return { hasTests: hasRealTests, passed: false, detail: "no test script", testFileCount: testFiles.length };
	if (!hasRealTests) return { hasTests: false, passed: false, detail: "no test files found", testFileCount: 0 };
	// Run node --test directly over the discovered test files: equivalent to the usual script, immune to script rewrites.
	const proc = await run(process.execPath, ["--test", ...testFiles.map((f) => f.replace(/^\.\//, ""))], dir, 300_000);
	const output = proc.stdout + proc.stderr;
	const pass = proc.code === 0;
	return {
		hasTests: true,
		passed: pass,
		detail: pass ? `own tests pass (${testFiles.length} files)` : `own tests fail: ${output.match(/fail (\d+)/)?.[1] ?? "?"} failing`,
		testFileCount: testFiles.length,
	};
}
