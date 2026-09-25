import { execFile } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";

const exec = promisify(execFile);

/** An archetype: a named engineering baseline a new project can be scaffolded from. */
export interface Archetype {
	name: string;
	title: string;
	description: string;
}

/** What an archetype's manifest declares: how the scaffolded project is built, verified and previewed. */
export interface ArchetypeManifest {
	title: string;
	description: string;
	/** The archetype carries the acceptance contract (a runner under acceptance/): from-idea projects are born with the gates on. */
	acceptance?: boolean;
	setup?: string;
	verify?: string;
	test?: string;
	previewCommand?: string;
	previewUrl?: string;
	/** Run after a preview starts; exit 0 means the URLs really are serving this app. */
	previewCheck?: string;
}

const readManifest = (config: Config, name: string): ArchetypeManifest | null => {
	const file = join(config.archetypesDir, name, "archetype.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as ArchetypeManifest;
	} catch {
		return null;
	}
};

/** Every archetype Tower ships (and any the person added to the archetypes directory). */
export function listArchetypes(config: Config): Archetype[] {
	if (!existsSync(config.archetypesDir)) return [];
	return readdirSync(config.archetypesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => {
			const manifest = readManifest(config, entry.name);
			return manifest ? [{ name: entry.name, title: manifest.title, description: manifest.description }] : [];
		});
}

const slugFor = (name: string): string =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "") || "project";

/** A free directory under <home>/repos, so scaffoling never collides with an earlier idea. */
export function targetDir(config: Config, name: string): string {
	const base = slugFor(name);
	let candidate = join(paths.repos(config), base);
	let n = 2;
	while (existsSync(candidate)) candidate = join(paths.repos(config), `${base}-${n++}`);
	return candidate;
}

/**
 * Scaffolds a repository from an archetype: the template copied whole, git-initialized on `main`,
 * everything committed as the scaffold commit — so the first card branches from a real baseline and
 * plans the app, not the toolchain. Returns the manifest, whose commands the project is born with.
 */
export async function scaffoldFromArchetype(options: { config: Config; archetype: string; dir: string }): Promise<ArchetypeManifest> {
	const { config, archetype, dir } = options;
	const manifest = readManifest(config, archetype);
	if (!manifest) throw new Error(`There is no archetype called "${archetype}"`);
	cpSync(join(config.archetypesDir, archetype), dir, { recursive: true, filter: (source) => !source.includes("node_modules") });
	const git = (...args: string[]) => exec("git", args, { cwd: dir, encoding: "utf8" });
	await git("init", "-q", "-b", "main");
	await git("add", ".");
	const identity = (await git("config", "user.email").then((email) => email.stdout.trim() !== "", () => false)) ? [] : ["-c", "user.name=Tower", "-c", "user.email=tower@localhost"];
	await git(...identity, "commit", "-q", "-m", `Scaffold from the ${archetype} archetype\n\nCreated by Tower: the engineering baseline, so the first card plans the app, not the toolchain.`);
	return manifest;
}
