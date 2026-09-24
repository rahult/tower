import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";

const exec = promisify(execFile);

/** The system model a read-only understanding pass produced, stamped with the commit it describes. */
export interface SystemModelMeta {
	commit: string;
	builtAt: number;
	/** The card whose understanding run produced the model; its transcript is the audit trail. */
	cardId: string;
}

export type ModelState = "missing" | "fresh" | "stale";

export const readModelMeta = (config: Config, projectId: string): SystemModelMeta | null => {
	const file = paths.systemModelMeta(config, projectId);
	if (!existsSync(file)) return null;
	try {
		const meta = JSON.parse(readFileSync(file, "utf8")) as Partial<SystemModelMeta>;
		if (typeof meta.commit !== "string" || typeof meta.builtAt !== "number") return null;
		return { commit: meta.commit, builtAt: meta.builtAt, cardId: typeof meta.cardId === "string" ? meta.cardId : "" };
	} catch {
		return null;
	}
};

/** The repository commit the model should describe. */
export const headCommit = async (repoPath: string, defaultBranch: string): Promise<string> => {
	const { stdout } = await exec("git", ["rev-parse", defaultBranch], { cwd: repoPath, encoding: "utf8" });
	return stdout.trim();
};

/**
 * How the model relates to the code as it stands: nothing built yet, built at the current head, or
 * built at an older head — the code has moved on and the model may no longer be telling the truth.
 */
export const modelState = async (config: Config, projectId: string, repoPath: string, defaultBranch: string): Promise<{ state: ModelState; meta: SystemModelMeta | null }> => {
	const meta = readModelMeta(config, projectId);
	if (!meta || !existsSync(paths.systemModel(config, projectId))) return { state: "missing", meta: null };
	let head: string;
	try {
		head = await headCommit(repoPath, defaultBranch);
	} catch {
		// An unreadable repository cannot prove staleness; the model stands until the repo answers.
		return { state: "fresh", meta };
	}
	return { state: head === meta.commit ? "fresh" : "stale", meta };
};

/**
 * Promotes an understanding run's report to the project's system model. The report is the card's own
 * artifact; the model is the project-level copy every planner reads, stamped with the commit it
 * describes so the next enqueue can tell fresh from stale.
 */
export const promoteSystemModel = async (options: { config: Config; projectId: string; repoPath: string; defaultBranch: string; cardId: string; reportPath: string }): Promise<SystemModelMeta> => {
	const { config, projectId, repoPath, defaultBranch, cardId, reportPath } = options;
	if (!existsSync(reportPath)) throw new Error(`The understanding run wrote no report at ${reportPath}`);
	const model = paths.systemModel(config, projectId);
	mkdirSync(dirname(model), { recursive: true });
	writeFileSync(model, readFileSync(reportPath, "utf8"));
	const meta: SystemModelMeta = { commit: await headCommit(repoPath, defaultBranch), builtAt: Date.now(), cardId };
	writeFileSync(paths.systemModelMeta(config, projectId), `${JSON.stringify(meta, null, 2)}\n`);
	return meta;
};

/** One line for prompts and UI: when the model was built, from which commit. */
export const describeModel = (config: Config, projectId: string): string => {
	const file = paths.systemModel(config, projectId);
	if (!existsSync(file)) return "";
	const meta = readModelMeta(config, projectId);
	const when = meta ? new Date(meta.builtAt).toISOString() : statSync(file).mtime.toISOString();
	return `built ${when}${meta?.commit ? ` at commit ${meta.commit.slice(0, 10)}` : ""}`;
};
