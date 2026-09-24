import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, repoRoot } from "./config.ts";
import { startDaemon } from "./daemon.ts";
import { PiSessionDriver } from "./pi/pi-driver.ts";
import { ensureWebDist } from "./web-build.ts";

const config = loadConfig();
ensureWebDist(config.webDist, repoRoot);
// Children inherit this process's environment: several providers (zai, deepseek, minimax, moonshot) authenticate
// through env vars, so start the daemon from a shell that has them.
const daemon = await startDaemon(config, new PiSessionDriver());
// The pi extension's `/tower stop` finds the daemon through this file.
const pidFile = join(config.home, "daemon.pid");
mkdirSync(config.home, { recursive: true });
writeFileSync(pidFile, String(process.pid));
console.log(`tower daemon listening on ${daemon.url} (data: ${config.home})`);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (closing) return;
		closing = true;
		console.log(`\n${signal} received, stopping sessions…`);
		void daemon.close().finally(() => {
			rmSync(pidFile, { force: true });
			process.exit(0);
		});
	});
}
