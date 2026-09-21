import { spawn } from "node:child_process";
import type { TranscriptBuffer } from "./run/transcript-buffer.ts";

export interface VerifyResult {
	passed: boolean;
	exitCode: number | null;
	output: string;
	aborted: boolean;
}

const FLUSH_MS = 200;
const MAX_KEPT_OUTPUT = 200_000;

/**
 * Runs a project's verify command in the card's worktree. The exit code, not an agent's opinion, decides whether
 * testing passed. Output streams into the run's transcript in batches so the drawer shows it live.
 */
export function runVerify(options: { command: string; cwd: string; timeoutMs: number; buffer: TranscriptBuffer }): { done: Promise<VerifyResult>; abort: () => void } {
	const { command, cwd, timeoutMs, buffer } = options;
	let aborted = false;
	let output = "";
	let pending = "";

	// detached: the command becomes a process-group leader, so abort can kill the whole tree (pnpm -> node -> …).
	const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
	const killTree = () => {
		try {
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		} catch {
			// already gone
		}
	};
	const flush = () => {
		if (!pending) return;
		buffer.push("verify_output", { text: pending });
		pending = "";
	};
	const onData = (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		output = (output + text).slice(-MAX_KEPT_OUTPUT);
		pending += text;
	};
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	const flusher = setInterval(flush, FLUSH_MS);
	const timer = setTimeout(() => {
		output += `\n[traffic-control] verify command timed out after ${Math.round(timeoutMs / 1000)}s`;
		killTree();
	}, timeoutMs);

	buffer.push("verify_started", { command });
	const done = new Promise<VerifyResult>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode) => {
			clearInterval(flusher);
			clearTimeout(timer);
			flush();
			resolve({ passed: exitCode === 0 && !aborted, exitCode, output, aborted });
		});
	});
	return {
		done,
		abort: () => {
			aborted = true;
			killTree();
		},
	};
}
