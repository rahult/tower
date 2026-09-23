import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
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

const FIRST_COMMIT_MESSAGE = "Initial commit\n\nCreated by Tower so that cards have a commit to branch from.";

/**
 * Gives a repository fresh out of `git init` its first commit: an empty tree, written with plumbing so the
 * user's index and working files are left exactly as they are (`git commit --allow-empty` would commit
 * whatever happens to be staged).
 */
async function createFirstCommit(repoPath: string, branch: string): Promise<void> {
	// Writes the empty tree object. (`git mktree` would do it too, but it reads stdin and would wait forever here.)
	const tree = await git(repoPath, "hash-object", "-w", "-t", "tree", "/dev/null");
	const hasIdentity = await git(repoPath, "config", "user.email").then(
		(email) => email !== "",
		() => false,
	);
	const identity = hasIdentity ? [] : ["-c", "user.name=Tower", "-c", "user.email=tower@localhost"];
	const commit = await git(repoPath, ...identity, "commit-tree", tree, "-m", FIRST_COMMIT_MESSAGE);
	await git(repoPath, "update-ref", `refs/heads/${branch}`, commit);
}

/**
 * Makes sure cards can branch from `baseBranch`. A brand-new repository gets its first commit; a branch that is
 * simply missing is the user's to sort out, so that throws with what to do.
 */
export async function ensureBaseBranch(repoPath: string, baseBranch: string): Promise<void> {
	if (await resolves(repoPath, baseBranch)) return;
	const unbornBranch = (await resolves(repoPath, "HEAD")) ? null : await git(repoPath, "symbolic-ref", "--short", "HEAD").catch(() => null);
	if (unbornBranch === baseBranch) return createFirstCommit(repoPath, baseBranch);
	throw new Error(
		`Tower branches each card from "${baseBranch}", but ${repoPath} has no branch with that name any more. Recreate it, or remove the project and add it again from the branch you want.`,
	);
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
		await ensureBaseBranch(repoPath, baseBranch);
		mkdirSync(dirname(path), { recursive: true });
		await git(repoPath, "worktree", "add", "-b", branchName, path, baseBranch);
	}
	return { path, branchName, baseCommit: await git(path, "merge-base", "HEAD", baseBranch), created };
}

/**
 * One worktree per crew stream, branched from the card's own base commit so every stream merges back cleanly.
 * Reused across a card's attempts: the branch is reset to the base and untracked files are cleared, but ignored
 * ones (an installed node_modules) survive, so the project's setup command runs once per stream, not per attempt.
 */
export async function ensureStreamWorktree(options: { repoPath: string; path: string; branchName: string; baseCommit: string }): Promise<Worktree> {
	const { repoPath, path, branchName, baseCommit } = options;
	const created = !existsSync(path);
	if (created) {
		mkdirSync(dirname(path), { recursive: true });
		await git(repoPath, "worktree", "add", "-b", branchName, path, baseCommit);
	} else {
		await git(path, "checkout", "-q", "-B", branchName, baseCommit);
		await git(path, "clean", "-qfd");
	}
	return { path, branchName, baseCommit, created };
}

export async function removeWorktree(repoPath: string, path: string): Promise<void> {
	if (existsSync(path)) await git(repoPath, "worktree", "remove", "--force", path);
}

/** The stream worktrees of a card live beside its own, named `<cardId>-ws-<slug>`; this lists their paths. */
export function streamWorktreePaths(worktreesDir: string, cardId: string): string[] {
	if (!existsSync(worktreesDir)) return [];
	return readdirSync(worktreesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith(`${cardId}-ws-`)).map((entry) => join(worktreesDir, entry.name));
}
