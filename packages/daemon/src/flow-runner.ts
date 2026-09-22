import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentStage, type Card, renderPrompt, resolveStageConfig, STAGE_RESULT_FILE, type ThinkingLevel } from "@tower/core";
import { type Config, paths } from "./config.ts";
import type { Db } from "./db/open.ts";
import { getCard } from "./db/repo-cards.ts";
import { getProject } from "./db/repo-projects.ts";
import { listRunsForCard } from "./db/repo-runs.ts";
import { type Flow, type FlowStep, loadFlows, readAgentFile, toolsFor } from "./flows.ts";
import type { CustomRun, RunOutcome, StageRunner } from "./stage-runner.ts";

const STAGES = new Set(["planning", "building", "testing"]);

export interface FlowRunnerDeps {
	config: Config;
	db: Db;
	stages: StageRunner;
}

/** Something a person asked to run against a card, outside its lifecycle. */
export interface AdhocRequest {
	prompt?: string;
	skill?: string;
	agent?: string;
	task?: string;
	model?: string;
	thinking?: ThinkingLevel;
	access?: "read-only" | "read-and-run" | "write";
}

/** Runs review flows and ad hoc requests as sessions in a card's worktree. */
export class FlowRunner {
	private readonly deps: FlowRunnerDeps;

	constructor(deps: FlowRunnerDeps) {
		this.deps = deps;
	}

	flow(name: string): Flow {
		const flow = loadFlows(this.deps.config).find((candidate) => candidate.name === name);
		if (!flow) throw new Error(`There is no flow called "${name}". Flows live in ${this.deps.config.flowsDir} and ${join(this.deps.config.home, "flows")}.`);
		return flow;
	}

	/** Runs the flows one after another. Stops early, returning the outcome, if a step is aborted or crashes. */
	async runFlows(cardId: string, names: string[]): Promise<RunOutcome> {
		let last: RunOutcome = { kind: "settled", stage: "testing", result: "pass", summary: "", hasQuestions: false };
		for (const name of names) {
			const flow = this.flow(name);
			for (const step of flow.steps) {
				last = await this.deps.stages.startCustom(cardId, this.request(cardId, step, { flow, requireResult: true }));
				if (last.kind !== "settled") return last;
			}
		}
		return last;
	}

	runAdhoc(cardId: string, request: AdhocRequest): Promise<RunOutcome> {
		const step: FlowStep = { name: "adhoc", ...request };
		return this.deps.stages.startCustom(cardId, this.request(cardId, step, { flow: null, requireResult: false }));
	}

	private request(cardId: string, step: FlowStep, options: { flow: Flow | null; requireResult: boolean }): CustomRun {
		const { config, db } = this.deps;
		const card = getCard(db, cardId) as Card;
		const project = getProject(db, card.projectId);
		const cardDir = paths.cardDir(config, cardId);
		const label = options.flow ? `${options.flow.name}${options.flow.steps.length > 1 ? `-${step.name}` : ""}` : "adhoc";
		const attempt = listRunsForCard(db, cardId).filter((run) => run.id.startsWith(`c${cardId}-${label}-`)).length + 1;
		const agent = step.agent ? readAgentFile(step.agent) : null;

		// Precedence: what the step asks for, then the agent file's own model, then the expensive tier.
		// A stage name ("planning") means "whatever runs that stage here", so reviews follow the person's model settings.
		const asked = step.model ?? agent?.model ?? "planning";
		const resolved = STAGES.has(asked) ? resolveStageConfig(asked as AgentStage, { card: card.stageConfig, project: project?.stageConfig, global: config.globalStageConfig }) : null;
		const model = resolved?.model ?? asked;
		const thinking = step.thinking ?? agent?.thinking ?? resolved?.thinking ?? "medium";

		const appendSystemPromptFiles: string[] = [];
		if (agent?.body) {
			mkdirSync(join(cardDir, "roles"), { recursive: true });
			const roleFile = join(cardDir, "roles", `${step.agent}.md`);
			writeFileSync(roleFile, agent.body);
			appendSystemPromptFiles.push(roleFile);
		}

		let prompt: string;
		try {
			prompt = this.prompt(card, step, options.flow ? join(cardDir, "reviews", `${label}.md`) : null);
		} catch (error) {
			// The usual cause is updating Tower's files while the daemon still runs the previous version.
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`The "${label}" prompt could not be rendered: ${reason}. If Tower was just updated, restart the daemon and run it again.`);
		}

		return {
			sessionId: `c${cardId}-${label}-${attempt}`,
			kind: options.flow ? "flow_step" : "adhoc",
			attempt,
			model,
			thinking,
			tools: agent?.tools?.length ? agent.tools : toolsFor(step.access ?? (options.flow ? "read-only" : "write")),
			prompt,
			appendSystemPromptFiles,
			requireResult: options.requireResult,
		};
	}

	private prompt(card: Card, step: FlowStep, reportPath: string | null): string {
		const { config } = this.deps;
		// pi expands /skill:name itself; an agent's role arrives as its system prompt, so the task is the whole prompt.
		if (step.skill) return `/skill:${step.skill}${step.task ? ` ${step.task}` : ""}`;
		if (step.agent) return step.task ?? `Do your job for this task: ${card.title}\n\n${card.brief}`;
		const cardDir = paths.cardDir(config, card.id);
		const read = (...parts: string[]) => readFileSync(join(config.promptsDir, ...parts), "utf8");
		// A flow step names a prompt file; an ad hoc request carries the text itself.
		const template = reportPath ? read("flows", step.prompt as string) : (step.prompt as string);
		if (!reportPath) return template;
		const resultContract = read("partials", "stage-result-contract.md");
		return renderPrompt(
			template,
			{
				title: card.title,
				brief: card.brief || "(no further description)",
				worktreePath: card.worktreePath ?? "",
				branchName: card.branchName ?? "",
				baseCommit: card.baseCommit ?? "HEAD",
				planPath: join(cardDir, "plan.md"),
				reportPath,
				resultPath: join(cardDir, STAGE_RESULT_FILE),
			},
			// renderPrompt expands partials in one pass, so the contract's own partial is filled in here.
			{
				"review-contract": read("flows", "_review-contract.md").replace("{{> stage-result-contract}}", resultContract.trim()),
				"stage-result-contract": resultContract,
				"invariant-protocol": read("partials", "invariant-protocol.md"),
			},
		);
	}
}
