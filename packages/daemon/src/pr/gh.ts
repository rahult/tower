import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
// gh must never stop to ask something: there is nobody at its terminal. Read per call, so PATH changes are seen.
const ghEnv = () => ({ ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" });

async function run(command: string, args: string[], cwd: string): Promise<string> {
	try {
		return (await exec(command, args, { cwd, env: ghEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
	} catch (error) {
		const { stderr = "", stdout = "", message } = error as { stderr?: string; stdout?: string; message: string };
		throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed: ${(stderr || stdout || message).trim().slice(-1500)}`);
	}
}

/** The remote a card's branch is pushed to, or null when the repository has none. */
export async function pushRemote(repoPath: string): Promise<string | null> {
	const remotes = (await run("git", ["remote"], repoPath)).split("\n").filter(Boolean);
	return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
}

export async function pushBranch(worktreePath: string, remote: string, branch: string): Promise<void> {
	await run("git", ["push", "--set-upstream", remote, branch], worktreePath);
}

export interface PullRequest {
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	headSha: string;
	/** Checks that have finished and failed, by name with a link. Empty while checks are pending or green. */
	failedChecks: Array<{ name: string; url: string }>;
	checksPending: boolean;
}

interface RawCheck {
	name?: string;
	context?: string;
	conclusion?: string;
	state?: string;
	status?: string;
	detailsUrl?: string;
	targetUrl?: string;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"]);

/** The pull request for a branch (or URL), or null when there is none. */
export async function viewPullRequest(cwd: string, branchOrUrl: string): Promise<PullRequest | null> {
	let raw: string;
	try {
		raw = await run("gh", ["pr", "view", branchOrUrl, "--json", "url,state,headRefOid,statusCheckRollup"], cwd);
	} catch (error) {
		if (/no pull requests found|could not resolve/i.test((error as Error).message)) return null;
		throw error;
	}
	const pr = JSON.parse(raw) as { url: string; state: PullRequest["state"]; headRefOid: string; statusCheckRollup?: RawCheck[] };
	const checks = pr.statusCheckRollup ?? [];
	const outcome = (check: RawCheck) => (check.conclusion || check.state || check.status || "").toUpperCase();
	return {
		url: pr.url,
		state: pr.state,
		headSha: pr.headRefOid,
		failedChecks: checks.filter((check) => FAILED.has(outcome(check))).map((check) => ({ name: check.name ?? check.context ?? "check", url: check.detailsUrl ?? check.targetUrl ?? "" })),
		checksPending: checks.some((check) => PENDING.has(outcome(check))),
	};
}

export async function createPullRequest(options: { cwd: string; title: string; body: string; base: string; head: string; bodyFile: string }): Promise<string> {
	writeFileSync(options.bodyFile, options.body);
	// Every flag is given, so gh has nothing to ask.
	const out = await run("gh", ["pr", "create", "--title", options.title, "--body-file", options.bodyFile, "--base", options.base, "--head", options.head], options.cwd);
	return out.split("\n").findLast((line) => line.startsWith("http")) ?? out;
}
