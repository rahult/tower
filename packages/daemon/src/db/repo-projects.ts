import type { Project } from "@tower/core";
import type { Db } from "./open.ts";

type Row = Record<string, string | number | null>;

function toProject(row: Row): Project {
	return {
		id: row.id as string,
		name: row.name as string,
		repoPath: row.repo_path as string,
		defaultBranch: row.default_branch as string,
		setupCommand: row.setup_command as string | null,
		verifyCommand: row.verify_command as string | null,
		testCommand: row.test_command as string | null,
		previewCommand: row.preview_command as string | null,
		previewUrl: row.preview_url as string | null,
		previewCheck: row.preview_check as string | null,
		budgetUsd: row.budget_usd as number | null,
		trustProjectPi: row.trust_project_pi === 1,
		extensions: JSON.parse(row.extensions_json as string),
		concurrencyLimit: row.concurrency_limit as number,
		stageConfig: JSON.parse(row.stage_config_json as string),
		reviewFlows: row.review_flows_json ? JSON.parse(row.review_flows_json as string) : null,
		invariantSimulation: row.invariant_simulation == null ? null : row.invariant_simulation === 1,
		subagents: row.subagents == null ? null : row.subagents === 1,
		understandBeforePlan: row.understand_before_plan == null ? null : row.understand_before_plan === 1,
		acceptanceGates: row.acceptance_gates == null ? null : row.acceptance_gates === 1,
		hasOrigin: row.has_origin == null ? null : row.has_origin === 1,
	createdAt: row.created_at as number,
};
}

export function insertProject(db: Db, project: Project): void {
	db.prepare(
		`INSERT INTO projects (id, name, repo_path, default_branch, setup_command, verify_command, test_command, preview_command, preview_url, preview_check, budget_usd, trust_project_pi,
			 extensions_json, concurrency_limit, stage_config_json, invariant_simulation, subagents, understand_before_plan, acceptance_gates, has_origin, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		project.id,
		project.name,
		project.repoPath,
		project.defaultBranch,
		project.setupCommand,
		project.verifyCommand,
		project.testCommand,
		project.previewCommand,
		project.previewUrl,
		project.previewCheck,
		project.budgetUsd,
		project.trustProjectPi ? 1 : 0,
		JSON.stringify(project.extensions),
		project.concurrencyLimit,
		JSON.stringify(project.stageConfig),
		project.invariantSimulation == null ? null : project.invariantSimulation ? 1 : 0,
		project.subagents == null ? null : project.subagents ? 1 : 0,
		project.understandBeforePlan == null ? null : project.understandBeforePlan ? 1 : 0,
		project.acceptanceGates == null ? null : project.acceptanceGates ? 1 : 0,
		project.hasOrigin == null ? null : project.hasOrigin ? 1 : 0,
		project.createdAt,
	);
}

export function listProjects(db: Db): Project[] {
	return (db.prepare("SELECT * FROM projects ORDER BY created_at").all() as Row[]).map(toProject);
}

/** Observed, not chosen: the probe result from boot (and from when the project was added). */
export function setProjectOrigin(db: Db, id: string, hasOrigin: boolean): void {
	db.prepare("UPDATE projects SET has_origin = ? WHERE id = ?").run(hasOrigin ? 1 : 0, id);
}

export function getProject(db: Db, id: string): Project | null {
	const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
	return row ? toProject(row) : null;
}

export type ProjectSettings = Partial<Pick<Project, "name" | "setupCommand" | "verifyCommand" | "testCommand" | "previewCommand" | "previewUrl" | "previewCheck" | "budgetUsd" | "concurrencyLimit" | "reviewFlows" | "invariantSimulation" | "subagents" | "understandBeforePlan" | "acceptanceGates">>;

const SETTING_COLUMNS = { name: "name", setupCommand: "setup_command", verifyCommand: "verify_command", testCommand: "test_command", previewCommand: "preview_command", previewUrl: "preview_url", previewCheck: "preview_check", budgetUsd: "budget_usd", concurrencyLimit: "concurrency_limit" } as const;

/** Toggles stored as nullable booleans, in their own columns. */
const TOGGLE_COLUMNS = { invariantSimulation: "invariant_simulation", subagents: "subagents", understandBeforePlan: "understand_before_plan", acceptanceGates: "acceptance_gates" } as const;

export function updateProject(db: Db, id: string, settings: ProjectSettings): Project {
	const { reviewFlows, invariantSimulation, subagents, understandBeforePlan, acceptanceGates, ...plain } = settings;
	if (reviewFlows !== undefined) db.prepare("UPDATE projects SET review_flows_json = ? WHERE id = ?").run(reviewFlows ? JSON.stringify(reviewFlows) : null, id);
	for (const [key, column] of Object.entries(TOGGLE_COLUMNS)) {
		const value = settings[key as keyof typeof TOGGLE_COLUMNS] as boolean | null | undefined;
		if (value !== undefined) db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(value == null ? null : value ? 1 : 0, id);
	}
	const keys = Object.keys(plain) as Array<keyof typeof SETTING_COLUMNS>;
	if (keys.length > 0) {
		const sets = keys.map((key) => `${SETTING_COLUMNS[key]} = ?`).join(", ");
		db.prepare(`UPDATE projects SET ${sets} WHERE id = ?`).run(...keys.map((key) => plain[key] ?? null), id);
	}
	const project = getProject(db, id);
	if (!project) throw new Error(`Project not found: ${id}`);
	return project;
}
