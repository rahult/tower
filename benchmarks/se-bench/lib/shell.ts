import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ShellResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Runs a command with a timeout; a killed run is reported as a non-zero exit, never thrown. */
export async function run(file: string, args: string[], cwd: string, timeoutMs = 120_000, input?: string): Promise<ShellResult> {
	try {
		const { stdout, stderr } = await execFileP(file, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: "SIGKILL", ...(input ? { input } : {}) });
		return { stdout, stderr, code: 0 };
	} catch (error: any) {
		return {
			stdout: (error.stdout ?? "").toString(),
			stderr: ((error.stderr ?? "") + "\n" + (error.message ?? "")).toString(),
			code: typeof error.code === "number" ? error.code : 124,
		};
	}
}

/** Runs a shell line (for tools the model writes). Output truncated for the transcript. */
export async function runShellLine(command: string, cwd: string, timeoutMs = 90_000): Promise<ShellResult> {
	return run("/bin/bash", ["-c", command], cwd, timeoutMs);
}
