#!/usr/bin/env node
// Dev: the backend in watch mode on :8787, the frontend on Vite's :5173 with /api proxied across.
// Both ports come from the environment (API_PORT, UI_PORT) so a busy default can be routed around —
// but a port that is quietly serving somebody else's app never is: busy ports fail fast, loudly.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apiPort = Number(process.env.API_PORT ?? 8787);
const uiPort = Number(process.env.UI_PORT ?? 5173);

// A port counts as busy when either loopback family answers, so a half-held port (one app on ::1,
// another on 0.0.0.0) is caught here instead of turning the /api proxy into a stranger's server.
const portBusy = (port) =>
	new Promise((resolve) => {
		let settled = false;
		const done = (busy) => {
			if (!settled) {
				settled = true;
				resolve(busy);
			}
		};
		for (const host of ["127.0.0.1", "::1"]) {
			const probe = createServer();
			probe.once("error", () => done(true));
			probe.once("listening", () => probe.close(() => done(false)));
			probe.listen(port, host);
		}
	});

for (const [name, port] of [["API", apiPort], ["UI", uiPort]]) {
	if (await portBusy(port)) {
		console.error(`[dev] Port ${port} is already in use — the ${name} server would collide with whatever holds it (another project's dev server?).`);
		console.error(`[dev] Free the port, or run again with ${name === "API" ? "API" : "UI"}_PORT=<free port>.`);
		process.exit(1);
	}
}

const run = (name, command, args, color, env = {}) => {
	const child = spawn(command, args, { cwd: root, env: { ...process.env, PORT: String(apiPort), ...env }, stdio: ["ignore", "pipe", "pipe"] });
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
run("web", "npx", ["vite", "--port", String(uiPort), "--strictPort"], "35");

process.on("SIGINT", () => process.exit(0));
