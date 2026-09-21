import type { RunSpec } from "@tower/core";

/**
 * RunSpec → pi CLI arguments (RpcClient adds `--mode rpc` itself). Pure and snapshot-tested:
 * this is the regression guard for pi CLI drift.
 *
 * Defaults are deliberately locked down: no extension discovery and no project trust, because pi has no
 * tool-approval gate and the user's global config loads many extensions. Both are opt-in per project.
 */
export function buildPiArgs(spec: RunSpec): string[] {
	const args = [
		"--session-dir",
		spec.sessionDir,
		"--session-id",
		spec.sessionId,
		"--model",
		spec.model,
		"--thinking",
		spec.thinking,
		"--tools",
		spec.tools.join(","),
		"--no-extensions",
	];
	for (const extension of spec.extensions) args.push("-e", extension);
	args.push(spec.trustProject ? "--approve" : "--no-approve");
	for (const file of spec.appendSystemPromptFiles) args.push("--append-system-prompt", file);
	return args;
}
