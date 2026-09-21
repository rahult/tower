import { loadConfig } from "./config.ts";
import { startDaemon } from "./daemon.ts";
import { PiSessionDriver } from "./pi/pi-driver.ts";

const config = loadConfig();
// Children inherit this process's environment: several providers (zai, deepseek, minimax, moonshot) authenticate
// through env vars, so start the daemon from a shell that has them.
const daemon = await startDaemon(config, new PiSessionDriver());
console.log(`traffic-control daemon listening on ${daemon.url} (data: ${config.home})`);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (closing) return;
		closing = true;
		console.log(`\n${signal} received, stopping sessions…`);
		void daemon.close().finally(() => process.exit(0));
	});
}
