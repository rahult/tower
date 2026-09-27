import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentStage, ThinkingLevel } from "@tower/core";
import type { Config } from "./config.ts";

/** What a step's session may do. Reviews never get edit; "read-and-run" adds bash so they can execute the code.
 *  "probe" is full access working in a throwaway probe directory — spike code runs there, not in the worktree. */
export type Access = "read-only" | "read-and-run" | "write" | "probe";
const TOOLS: Record<Access, string[]> = {
	"read-only": ["read", "grep", "find", "ls", "write"],
	"read-and-run": ["read", "grep", "find", "ls", "bash", "write"],
	write: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	probe: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};
// "write" is present even for reviews because the report and result file are written with it; the prompt forbids touching the repository.
export const toolsFor = (access: Access) => TOOLS[access];

export interface FlowStep {
	name: string;
	/** Exactly one of these says what the step does. */
	prompt?: string;
	/** Inline instructions for an agent step — a model session without a template file. What composed flows use. */
	text?: string;
	skill?: string;
	agent?: string;
	/** A shell command instead of a model session: deterministic, no spend, the exit code is the verdict. */
	run?: string;
	/** "pass" (default): a non-zero exit fails the flow. "note": the output is recorded, the exit code never fails it. */
	expect?: "pass" | "note";
	/** How long the command may run. Default 10 minutes. */
	timeoutSec?: number;
	/** Extra text: arguments for a skill, the task for an agent. */
	task?: string;
	/** A stage name ("planning" = the expensive tier) or an explicit provider/model. */
	model?: AgentStage | string;
	thinking?: ThinkingLevel;
	access?: Access;
	/** Where the walk goes on each verdict. A missing key falls through to the next step in file order; no next step ends the flow. Absent entirely, the flow is linear. */
	on?: Partial<Record<StepVerdict, string>>;
	/** How many times one flow execution may run this node. Default 3 — a repair loop has to be able to fail. */
	maxRuns?: number;
}

/** The verdicts an edge can route on. A "blocked" step never takes an edge — it falls through or parks the card. */
export type StepVerdict = "pass" | "fail";

/** When a flow runs. Manual flows appear in the drawer's Run tab; the others are lifecycle hooks. */
export type FlowTrigger = "manual" | "after-plan" | "after-build" | "after-tests" | "schedule";
const TRIGGERS = new Set<FlowTrigger>(["manual", "after-plan", "after-build", "after-tests", "schedule"]);

export interface Flow {
	name: string;
	title: string;
	description: string;
	when: FlowTrigger[];
	/** For scheduled flows: how often to fire, in hours (0 = every tick). Default 24. */
	intervalHours?: number;
	steps: FlowStep[];
	/** Where the walk begins. Default: the first step. */
	start?: string;
	/** The editor's node positions. The runner never reads it. */
	layout?: Record<string, { x: number; y: number }>;
}

/** Flows shipped with Tower, overridden or extended by the person's own in <home>/flows. */
export function loadFlows(config: Config): Flow[] {
	const byName = new Map<string, Flow>();
	for (const dir of [config.flowsDir, join(config.home, "flows")]) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".flow.json")).sort()) {
			const flow = parseFlow(readFileSync(join(dir, file), "utf8"), file);
			byName.set(flow.name, flow);
		}
	}
	return [...byName.values()];
}

export function parseFlow(text: string, source: string): Flow {
	let raw: Partial<Flow>;
	try {
		raw = JSON.parse(text) as Partial<Flow>;
	} catch {
		throw new Error(`${source} is not valid JSON`);
	}
	if (typeof raw.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(raw.name)) throw new Error(`${source}: "name" must be lower-case words joined by dashes`);
	if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error(`${source}: a flow needs at least one step`);
	const when = raw.when ?? ["manual"];
	if (!Array.isArray(when) || when.length === 0 || when.some((trigger) => !TRIGGERS.has(trigger as FlowTrigger))) {
		throw new Error(`${source}: "when" must be a non-empty list of ${[...TRIGGERS].join(", ")}`);
	}
	const names = new Set(raw.steps.map((step) => step.name as string));
	raw.steps.forEach((step, index) => {
		const kinds = [step.prompt, step.text, step.skill, step.agent, step.run].filter((value) => typeof value === "string" && value !== "");
		if (kinds.length !== 1) throw new Error(`${source}: step ${index + 1} must have exactly one of "prompt", "text", "skill", "agent" or "run"`);
		if (typeof step.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(step.name)) throw new Error(`${source}: step ${index + 1} needs a "name" of lower-case words joined by dashes`);
		if (step.access !== undefined && !(step.access in TOOLS)) throw new Error(`${source}: step "${step.name}" has unknown access "${step.access}"`);
		if (step.expect !== undefined && step.expect !== "pass" && step.expect !== "note") throw new Error(`${source}: step "${step.name}" has unknown expect "${step.expect}" (pass or note)`);
		if (step.timeoutSec !== undefined && (!Number.isFinite(step.timeoutSec) || step.timeoutSec <= 0)) throw new Error(`${source}: step "${step.name}" needs a positive "timeoutSec"`);
		if (step.on !== undefined) {
			const edges = Object.entries(step.on);
			if (edges.length === 0) throw new Error(`${source}: step "${step.name}" has an empty "on" — drop it, or edge "pass" or "fail" to a step`);
			for (const [verdict, target] of edges) {
				if (verdict !== "pass" && verdict !== "fail") throw new Error(`${source}: step "${step.name}" edges on "${verdict}" — only "pass" and "fail" are verdicts`);
				if (typeof target !== "string" || !names.has(target)) throw new Error(`${source}: step "${step.name}" edges "${verdict}" to "${String(target)}", which is not a step of this flow`);
			}
		}
		if (step.maxRuns !== undefined && (!Number.isInteger(step.maxRuns) || step.maxRuns < 1)) throw new Error(`${source}: step "${step.name}" needs a whole number of at least 1 for "maxRuns"`);
	});
	if (raw.start !== undefined && (typeof raw.start !== "string" || !names.has(raw.start))) throw new Error(`${source}: "start" must name a step of this flow`);
	if (raw.intervalHours !== undefined && (!Number.isFinite(raw.intervalHours) || raw.intervalHours < 0 || raw.intervalHours > 8760)) {
		throw new Error(`${source}: "intervalHours" must be a number from 0 (every tick) to 8760 (a year)`);
	}
	return {
		name: raw.name,
		title: raw.title ?? raw.name,
		description: raw.description ?? "",
		when: [...new Set(when)],
		steps: raw.steps,
		...(raw.start !== undefined ? { start: raw.start } : {}),
		...(raw.intervalHours !== undefined ? { intervalHours: raw.intervalHours } : {}),
		...(raw.layout !== undefined ? { layout: raw.layout } : {}),
	};
}

/** The flows that run at a lifecycle moment, in file order — deterministic because the names sort them. */
export const flowsTriggered = (flows: Flow[], trigger: FlowTrigger): Flow[] => flows.filter((flow) => flow.when.includes(trigger));

/** How often a node may run before the walk calls the loop stuck. */
export const DEFAULT_MAX_NODE_RUNS = 3;

/**
 * The next node after a verdict: the explicit edge wins, else the next step in file order (a linear
 * flow), else the flow ends. `blocked` never reaches here — the runner parks the card first.
 */
export function nextStep(flow: Flow, step: FlowStep, verdict: StepVerdict): FlowStep | null {
	const target = step.on?.[verdict];
	if (target) return flow.steps.find((candidate) => candidate.name === target) ?? null;
	const index = flow.steps.indexOf(step);
	return (index >= 0 ? flow.steps[index + 1] : undefined) ?? null;
}

/**
 * Whether a flow is safe on a card with no worktree (a backlog card): no commands, no writes —
 * read-only or read-and-run agent sessions working straight in the project checkout.
 */
export const runsOnBacklogCard = (flow: Flow): boolean => flow.steps.every((step) => step.run === undefined && step.access !== "write");

export interface AgentFile {
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	/** The role's system prompt: the Markdown below the frontmatter. */
	body: string;
}

/**
 * Reads one of the person's pi agent role files (~/.pi/agent/agents/<name>.md). pi itself has no agents concept,
 * so Tower translates the frontmatter into CLI flags and passes the body as an appended system prompt.
 */
export function readAgentFile(name: string, env: NodeJS.ProcessEnv = process.env): AgentFile {
	if (!/^[\w.-]+$/.test(name)) throw new Error(`"${name}" is not an agent name`);
	const file = join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "agents", `${name}.md`);
	if (!existsSync(file)) throw new Error(`No agent file at ${file}`);
	const text = readFileSync(file, "utf8");
	const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { body: text };
	const fields = Object.fromEntries(
		(match[1] as string)
			.split("\n")
			.map((line) => line.match(/^([\w-]+):\s*(.*)$/))
			.filter((m): m is RegExpMatchArray => m !== null)
			.map((m) => [m[1], (m[2] as string).trim().replace(/^["']|["']$/g, "")]),
	);
		const tools = fields.tools ? fields.tools.split(",").map((tool: string) => tool.trim().toLowerCase()).filter(Boolean) : undefined;
		return { model: fields.model || undefined, thinking: (fields.thinking as ThinkingLevel) || undefined, tools, body: (match[2] as string).trim() };
}

/** Where a flow's file lives: shipped with Tower, or the person's own (<home>/flows — an override counts as their own). */
export function flowSource(config: Config, name: string): "shipped" | "custom" {
	return existsSync(join(config.home, "flows", `${name}.flow.json`)) ? "custom" : "shipped";
}

/** Validates and writes a flow as the person's own; a shipped name becomes an override. */
export function saveFlow(config: Config, text: string): { flow: Flow; overridden: boolean } {
	const flow = parseFlow(text, "the submitted flow");
	const overridden = existsSync(join(config.flowsDir, `${flow.name}.flow.json`));
	const dir = join(config.home, "flows");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${flow.name}.flow.json`), `${JSON.stringify(flow, null, "\t")}\n`);
	return { flow, overridden };
}

/** Removes the person's copy of a flow. A shipped original survives — the override just falls back to it. */
export function deleteFlow(config: Config, name: string): boolean {
	const file = join(config.home, "flows", `${name}.flow.json`);
	if (!existsSync(file)) return false;
	unlinkSync(file);
	return true;
}
