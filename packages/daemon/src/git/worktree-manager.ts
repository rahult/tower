import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

export async function isGitRepo(path: string): Promise<boolean> {
	try {
		return (await git(path, "rev-parse", "--is-inside-work-tree")) === "true";
	} catch {
		return false;
	}
}

/** The branch the repo currently has checked out; used as the base for card branches and PRs. */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
	return git(repoPath, "symbolic-ref", "--short", "HEAD");
}

export function branchNameFor(cardId: string, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug ? `tc/${cardId}-${slug}` : `tc/${cardId}`;
}

export interface Worktree {
	path: string;
	branchName: string;
	baseCommit: string;
	/** True when this call created the worktree, so one-time setup should run. */
	created: boolean;
}

/** One git worktree per card: pi has no repo locking, so isolation between concurrent cards is ours to provide. */
export async function ensureWorktree(options: { repoPath: string; path: string; branchName: string; baseBranch: string }): Promise<Worktree> {
	const { repoPath, path, branchName, baseBranch } = options;
	const created = !existsSync(path);
	if (created) {
		mkdirSync(dirname(path), { recursive: true });
		await git(repoPath, "worktree", "add", "-b", branchName, path, baseBranch);
	}
	return { path, branchName, baseCommit: await git(path, "merge-base", "HEAD", baseBranch), created };
}

export async function removeWorktree(repoPath: string, path: string): Promise<void> {
	if (existsSync(path)) await git(repoPath, "worktree", "remove", "--force", path);
}
