import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

/** True when `ancestor` is already contained in `ref`, so there is nothing left to merge. */
async function isAncestor(repoPath: string, ancestor: string, ref: string): Promise<boolean> {
	try {
		await git(repoPath, "merge-base", "--is-ancestor", ancestor, ref);
		return true;
	} catch {
		return false;
	}
}

/** The user's identity when the repo has one; otherwise Tower's, so a merge commit never fails for lack of an author. */
async function identityArgs(repoPath: string): Promise<string[]> {
	const hasIdentity = await git(repoPath, "config", "user.email").then(
		(email) => email !== "",
		() => false,
	);
	return hasIdentity ? [] : ["-c", "user.name=Tower", "-c", "user.email=tower@localhost"];
}

interface Checkout {
	/** Absolute path of the checkout (the repository itself, or a linked worktree). */
	path: string;
	branch: string | null;
	/** The repository's own checkout, not a linked worktree. */
	isMain: boolean;
}

/** Every checkout of the repository, its main one first — `git worktree list --porcelain` guarantees that order. */
async function listCheckouts(repoPath: string): Promise<Checkout[]> {
	const raw = await git(repoPath, "worktree", "list", "--porcelain");
	const checkouts: Checkout[] = [];
	for (const block of raw.split("\n\n")) {
		const lines = block.split("\n");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (!path) continue;
		const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).replace("refs/heads/", "") ?? null;
		checkouts.push({ path, branch, isMain: checkouts.length === 0 });
	}
	return checkouts;
}

export interface LocalMerge {
	/** `checkout`: merged in a checkout of the default branch; `plumbing`: merged by moving the branch's ref, no checkout touched. */
	via: "checkout" | "plumbing";
	commit: string;
}

/**
 * Merges a card's branch into the project's default branch locally, the way the person would have: git's own merge,
 * fast-forwarding when the branch is simply ahead and making a merge commit when the histories diverged. The default
 * branch's checkout, if any, gets the merged files; when the branch is checked out nowhere, only its ref moves.
 * The card branch itself is left for the orchestrator's cleanup, which deletes it once its worktree is gone.
 * Throws with what to do next — the message lands on the card as the reason it needs attention, and Retry tries again.
 */
export async function mergeBranchLocally(options: { repoPath: string; branch: string; defaultBranch: string; message: string }): Promise<LocalMerge> {
	const { repoPath, branch, defaultBranch, message } = options;
	const head = await git(repoPath, "rev-parse", "--verify", `refs/heads/${defaultBranch}`);
	const theirs = await git(repoPath, "rev-parse", "--verify", `refs/heads/${branch}`);
	// Everything the branch has is already on the default branch (merged by hand, or an earlier attempt): nothing to do.
	if (await isAncestor(repoPath, theirs, head)) return { via: "plumbing", commit: head };

	const identity = await identityArgs(repoPath);
	const holder = (await listCheckouts(repoPath)).find((checkout) => checkout.branch === defaultBranch);
	if (holder) {
		const dirty = (await git(holder.path, "status", "--porcelain")) !== "";
		if (dirty) {
			throw new Error(
				`Your checkout at ${holder.path} has uncommitted changes, so Tower did not merge ${branch} into ${defaultBranch}. Commit or stash them there, then Retry: Tower merges and finishes the card.`,
			);
		}
		try {
			await git(holder.path, ...identity, "merge", "-m", message, branch);
		} catch (error) {
			await abortMerge(holder.path);
			throw new Error(
				`Merging ${branch} into ${defaultBranch} did not go cleanly, so Tower left ${defaultBranch} alone. Merge ${branch} in ${holder.path} yourself, then Retry: Tower notices the merge and finishes the card. (${tail(error)})`,
			);
		}
		return { via: "checkout", commit: await git(repoPath, "rev-parse", `refs/heads/${defaultBranch}`) };
	}

	// The default branch is checked out nowhere, so the merge moves the ref without touching any checkout.
	if (await isAncestor(repoPath, head, theirs)) {
		await git(repoPath, "update-ref", `refs/heads/${defaultBranch}`, theirs, head);
		return { via: "plumbing", commit: theirs };
	}
	return plumbingMerge({ repoPath, defaultBranch, branch, head, identity, message });
}

/**
 * The default branch is checked out nowhere, so the merge happens without touching any checkout: a real merge via
 * `git merge-tree`, committed with plumbing, and the ref moves in one atomic step that refuses if it moved meanwhile.
 */
async function plumbingMerge(options: { repoPath: string; defaultBranch: string; branch: string; head: string; identity: string[]; message: string }): Promise<LocalMerge> {
	const { repoPath, defaultBranch, branch, head, identity, message } = options;
	let tree: string;
	try {
		tree = (await git(repoPath, ...identity, "merge-tree", "--write-tree", defaultBranch, branch)).split("\n")[0] as string;
	} catch (error) {
		if (/usage|unknown option|invalid option/i.test(tail(error))) {
			throw new Error(`Tower merges ${branch} into ${defaultBranch} with git's merge-tree, which git here is too old for. Merge ${branch} into ${defaultBranch} yourself, then Retry.`);
		}
		await abortMerge(repoPath);
		throw new Error(
			`Merging ${branch} into ${defaultBranch} hits conflicts, so Tower left ${defaultBranch} alone. Merge ${branch} yourself, then Retry: Tower notices the merge and finishes the card.`,
		);
	}
	const commit = await git(repoPath, ...identity, "commit-tree", tree, "-p", head, "-p", `refs/heads/${branch}`, "-m", message);
	await git(repoPath, "update-ref", `refs/heads/${defaultBranch}`, commit, head);
	return { via: "plumbing", commit };
}

/**
 * Called by the orchestrator's cleanup once the card's worktree is gone, so the branch is no longer checked out
 * anywhere. Deleted only when git shows it fully inside the default branch; anything else lingers untouched.
 */
export async function deleteMergedBranch(repoPath: string, branch: string, baseBranch: string): Promise<void> {
	if (await isAncestor(repoPath, branch, baseBranch)) await git(repoPath, "branch", "-D", branch).catch(() => {});
}

/** Leaves no half-finished merge behind: git refuses when there is none, which is exactly the check. */
async function abortMerge(cwd: string): Promise<void> {
	await git(cwd, "merge", "--abort").catch(() => {});
}

function tail(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(-300).trim();
}
