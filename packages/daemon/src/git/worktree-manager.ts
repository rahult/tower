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

async function resolves(repoPath: string, ref: string): Promise<boolean> {
	try {
		await git(repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Why Tower cannot branch from `baseBranch`, in words a person can act on, or null when it can.
 * A repository fresh out of `git init` names its branch but has no commit for it to point at.
 */
export async function branchProblem(repoPath: string, baseBranch: string): Promise<string | null> {
	if (await resolves(repoPath, baseBranch)) return null;
	if (!(await resolves(repoPath, "HEAD"))) {
		return `${repoPath} has no commits yet, so there is nothing for a card's branch to start from. Make a first commit, for example: git -C "${repoPath}" commit --allow-empty -m "Initial commit"`;
	}
	return `Tower branches each card from "${baseBranch}", but ${repoPath} has no branch with that name any more. Recreate it, or remove the project and add it again from the branch you want.`;
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
	return slug ? `tower/${cardId}-${slug}` : `tower/${cardId}`;
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
		const problem = await branchProblem(repoPath, baseBranch);
		if (problem) throw new Error(problem);
		mkdirSync(dirname(path), { recursive: true });
		await git(repoPath, "worktree", "add", "-b", branchName, path, baseBranch);
	}
	return { path, branchName, baseCommit: await git(path, "merge-base", "HEAD", baseBranch), created };
}

export async function removeWorktree(repoPath: string, path: string): Promise<void> {
	if (existsSync(path)) await git(repoPath, "worktree", "remove", "--force", path);
}
