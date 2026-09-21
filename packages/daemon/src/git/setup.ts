import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

/** Runs a project's one-time worktree setup (for example `pnpm install`). Throws with the output tail on failure. */
export async function runSetup(command: string, cwd: string): Promise<void> {
	try {
		await run(command, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60_000 });
	} catch (error) {
		const { stderr = "", stdout = "" } = error as { stderr?: string; stdout?: string };
		throw new Error(`Setup command failed: ${command}\n${`${stdout}\n${stderr}`.trim().slice(-2000)}`);
	}
}
