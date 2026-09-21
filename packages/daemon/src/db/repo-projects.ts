import type { Project } from "@traffic-control/core";
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
		trustProjectPi: row.trust_project_pi === 1,
		extensions: JSON.parse(row.extensions_json as string),
		concurrencyLimit: row.concurrency_limit as number,
		stageConfig: JSON.parse(row.stage_config_json as string),
		createdAt: row.created_at as number,
	};
}

export function insertProject(db: Db, project: Project): void {
	db.prepare(
		`INSERT INTO projects (id, name, repo_path, default_branch, setup_command, verify_command, trust_project_pi,
			extensions_json, concurrency_limit, stage_config_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		project.id,
		project.name,
		project.repoPath,
		project.defaultBranch,
		project.setupCommand,
		project.verifyCommand,
		project.trustProjectPi ? 1 : 0,
		JSON.stringify(project.extensions),
		project.concurrencyLimit,
		JSON.stringify(project.stageConfig),
		project.createdAt,
	);
}

export function listProjects(db: Db): Project[] {
	return (db.prepare("SELECT * FROM projects ORDER BY created_at").all() as Row[]).map(toProject);
}

export function getProject(db: Db, id: string): Project | null {
	const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
	return row ? toProject(row) : null;
}
