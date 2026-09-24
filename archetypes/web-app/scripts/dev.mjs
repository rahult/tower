#!/usr/bin/env node
// Dev: the backend in watch mode on :8787, the frontend on Vite's :5173 with /api proxied across.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const run = (name, command, args, color) => {
	const child = spawn(command, args, { cwd: root, env: { ...process.env, PORT: "8787" }, stdio: ["ignore", "pipe", "pipe"] });
	const tag = `\x1b[${color}m[${name}]\x1b[0m`;
	const pipe = (stream) => {
		let pending = "";
		stream.on("data", (chunk) => {
			pending += String(chunk);
			let at;
			while ((at = pending.indexOf("\n")) !== -1) {
				process.stdout.write(`${tag} ${pending.slice(0, at + 1)}`);
				pending = pending.slice(at + 1);
			}
		});
	};
	pipe(child.stdout);
	pipe(child.stderr);
	child.on("exit", (code) => process.exit(code ?? 0));
	return child;
};

// The backend watcher needs a first build before the server can run.
rmSync(join(root, "dist"), { recursive: true, force: true });
run("server", "npx", ["tsc", "-p", "server", "--watch", "--preserveWatchOutput"], "34");
const wait = setInterval(() => {
	if (existsSync(join(root, "dist", "index.js"))) {
		clearInterval(wait);
		run("node", process.execPath, ["--watch", join(root, "dist", "index.js")], "34");
	}
}, 200);
run("web", "npx", ["vite"], "35");

process.on("SIGINT", () => process.exit(0));
