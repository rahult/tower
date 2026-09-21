import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Everything the card changed since it branched: committed and uncommitted, plus new untracked files by name. */
export async function cardDiff(worktreePath: string, baseCommit: string): Promise<{ diff: string; untracked: string[] }> {
	const run = async (...args: string[]) => (await exec("git", args, { cwd: worktreePath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout;
	const [diff, untracked] = await Promise.all([run("diff", baseCommit), run("ls-files", "--others", "--exclude-standard")]);
	return { diff, untracked: untracked.split("\n").filter(Boolean) };
}
