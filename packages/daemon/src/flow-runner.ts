import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentStage, type Card, renderPrompt, resolveStageConfig, type StageRun, STAGE_RESULT_FILE, type ThinkingLevel } from "@tower/core";
import { type Config, paths } from "./config.ts";
import type { Db } from "./db/open.ts";
import { getCard } from "./db/repo-cards.ts";
import { getProject } from "./db/repo-projects.ts";
import { getRun, insertRun, listRunsForCard, updateRun } from "./db/repo-runs.ts";
import type { Bus } from "./events/bus.ts";
import { type Flow, type FlowStep, loadFlows, readAgentFile, runsOnBacklogCard, toolsFor } from "./flows.ts";
import type { RunManager } from "./run/run-manager.ts";
import type { CustomRun, RunOutcome, StageRunner } from "./stage-runner.ts";
import { runCommand } from "./verifier.ts";

const STAGES = new Set(["planning", "building", "testing"]);
/** How long a deterministic step may run when the flow does not say. */
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

export interface FlowRunnerDeps {
	config: Config;
	db: Db;
	bus: Bus;
	runs: RunManager;
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

/** The run id a step's sessions and commands share, so the drawer's rail groups them. */
const stepLabel = (flow: Flow, step: FlowStep): string => `${flow.name}${flow.steps.length > 1 ? `-${step.name}` : ""}`;

/** Runs review flows and ad hoc requests as sessions in a card's worktree. */
export class FlowRunner {
	private readonly deps: FlowRunnerDeps;
	/** The deterministic step a card has in flight, so an abort can kill its process tree. */
	private readonly stepAborts = new Map<string, () => void>();

	constructor(deps: FlowRunnerDeps) {
		this.deps = deps;
	}

	flow(name: string): Flow {
		const flow = loadFlows(this.deps.config).find((candidate) => candidate.name === name);
		if (!flow) throw new Error(`There is no flow called "${name}". Flows live in ${this.deps.config.flowsDir} and ${join(this.deps.config.home, "flows")}.`);
		return flow;
	}

	/** Kills the card's in-flight command step, if it has one. Sessions are aborted through the stage runner. */
	abort(cardId: string): void {
		this.stepAborts.get(cardId)?.();
	}

	/**
	 * Runs the flows one after another. A crash or abort stops early. A deterministic step that fails also
	 * stops the flow — a failed gate says the work is not worth the next step — while an agent's "fail"
	 * verdict is a finding, not a crash, so later steps still run. `feedback` carries what a previous
	 * failed run of this hook said, so the rerun's agent steps fix the cause instead of repeating it.
	 */
	async runFlows(cardId: string, names: string[], feedback?: string): Promise<RunOutcome> {
		let last: RunOutcome = { kind: "settled", stage: "testing", result: "pass", summary: "", hasQuestions: false };
		for (const name of names) {
			const outcome = await this.runOneFlow(cardId, name, feedback);
			if (outcome.kind !== "settled") return outcome;
			if (outcome.result !== "pass") return outcome;
			last = outcome;
		}
		return last;
	}

	/** Runs independent flows at the same time — a review fan-out. Verdicts combine; crashes and aborts win. */
	async runFlowsConcurrently(cardId: string, names: string[]): Promise<RunOutcome> {
		const outcomes = await Promise.all(names.map((name) => this.runOneFlow(cardId, name, undefined, true)));
		const failed = outcomes.find((outcome) => outcome.kind === "failed");
		if (failed) return failed;
		const aborted = outcomes.find((outcome) => outcome.kind === "aborted");
		if (aborted) return aborted;
		return { kind: "settled", stage: "testing", result: "pass", summary: outcomes.map((outcome) => (outcome.kind === "settled" ? outcome.summary : "")).filter(Boolean).join(" · "), hasQuestions: false };
	}

	/** One flow, start to finish: its steps in order, its own verdict. */
	private async runOneFlow(cardId: string, name: string, feedback?: string, shared = false): Promise<RunOutcome> {
		const flow = this.flow(name);
		// A card with no worktree (research on a backlog card) may only run flows that touch no code.
		const card = getCard(this.deps.db, cardId);
		if (card && !card.worktreePath && !runsOnBacklogCard(flow)) {
			throw new Error(`"${name}" runs commands or changes code, so it needs the card's worktree — start the card first.`);
		}
		let last: RunOutcome = { kind: "settled", stage: "testing", result: "pass", summary: "", hasQuestions: false };
		for (const step of flow.steps) {
			last = step.run !== undefined ? await this.runStep(cardId, flow, step, shared) : await this.deps.stages.startCustom(cardId, this.request(cardId, step, { flow, requireResult: true, feedback, shared }));
			if (last.kind !== "settled") return last;
			if (step.run !== undefined && last.result !== "pass") return last;
		}
		return last;
	}

	runAdhoc(cardId: string, request: AdhocRequest): Promise<RunOutcome> {
		const step: FlowStep = { name: "adhoc", ...request };
		return this.deps.stages.startCustom(cardId, this.request(cardId, step, { flow: null, requireResult: false }));
	}

	/**
	 * A deterministic step: a command, no model, the exit code is the verdict. Recorded like any other run
	 * so the rail and the transcript show it; output streams through the same blocks as the verify command.
	 */
	private async runStep(cardId: string, flow: Flow, step: FlowStep, shared = false): Promise<RunOutcome> {
		const { config, db, runs } = this.deps;
		const card = getCard(db, cardId) as Card;
		const project = getProject(db, card.projectId);
		if (!card.worktreePath || !project) throw new Error(`Card ${cardId} has no worktree for "${step.name}" to run in`);
		const label = stepLabel(flow, step);
		const attempt = listRunsForCard(db, cardId).filter((run) => run.id.startsWith(`c${cardId}-${label}-`)).length + 1;
		const command = this.expand(step.run as string, card, project.repoPath, card.title);
		const run: StageRun = {
			id: `c${cardId}-${label}-${attempt}`,
			cardId,
			kind: "flow_step",
			stage: card.stage,
			attempt,
			model: command,
			thinking: "off",
			args: [step.expect ?? "pass"],
			status: "running",
			resultStatus: null,
			resultSummary: null,
			questions: null,
			tokens: null,
			costUsd: null,
			lastEntryId: null,
			startedAt: Date.now(),
			endedAt: null,
			error: null,
		};
		insertRun(db, run);
		this.publish(run.id);

		const live = runs.openLog(cardId, run.id, { shared });
		const executed = runCommand({
			command,
			cwd: card.worktreePath,
			timeoutMs: step.timeoutSec !== undefined ? step.timeoutSec * 1000 : DEFAULT_STEP_TIMEOUT_MS,
			buffer: live.buffer,
			events: { started: "verify_started", output: "verify_output" },
			label: `step "${step.name}"`,
		});
		this.stepAborts.set(cardId, executed.abort);
		let result;
		try {
			result = await executed.done;
		} finally {
			this.stepAborts.delete(cardId);
		}

		const expect = step.expect ?? "pass";
		const passed = result.aborted ? false : expect === "note" ? true : result.passed;
		const summary = result.aborted
			? "Aborted."
			: expect === "note"
				? `Recorded, exit ${result.exitCode ?? "?"} — informational, it never fails the flow.`
				: result.passed
					? "Command passed."
					: `Command exited with code ${result.exitCode ?? "?"}${lastLine(result.output)}`;
		updateRun(db, run.id, { status: result.aborted ? "aborted" : "settled", resultStatus: result.aborted ? null : passed ? "pass" : "fail", resultSummary: summary, endedAt: Date.now() });
		runs.note(run.id, "run_finished", { status: summary });
		await runs.finish(run.id);
		this.publish(run.id);
		if (result.aborted) return { kind: "aborted" };
		return { kind: "settled", stage: "building", result: passed ? "pass" : "fail", summary, hasQuestions: false };
	}

	/** The variables a deterministic step's command may reference. */
	private expand(command: string, card: Card, repoPath: string, title: string): string {
		return command
			.replaceAll("{{worktreePath}}", card.worktreePath ?? "")
			.replaceAll("{{repoPath}}", repoPath)
			.replaceAll("{{branchName}}", card.branchName ?? "")
			.replaceAll("{{cardDir}}", paths.cardDir(this.deps.config, card.id))
			.replaceAll("{{title}}", title);
	}

	private publish(runId: string): void {
		this.deps.bus.publish({ topic: "board", type: "run_upserted", data: getRun(this.deps.db, runId) });
	}

	private request(cardId: string, step: FlowStep, options: { flow: Flow | null; requireResult: boolean; feedback?: string; shared?: boolean }): CustomRun {
		const { config, db } = this.deps;
		const card = getCard(db, cardId) as Card;
		const project = getProject(db, card.projectId);
		const cardDir = paths.cardDir(config, cardId);
		const label = options.flow ? stepLabel(options.flow, step) : "adhoc";
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
			if (options.feedback) prompt += `\n\n## What should change\n\nThe previous run of this gate did not pass, so the card stopped:\n\n${options.feedback}\n\nFind and fix the cause in this run — do not simply restate last run's output.`;
		} catch (error) {
			// The usual cause is updating Tower's files while the daemon still runs the previous version.
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`The "${label}" prompt could not be rendered: ${reason}. If Tower was just updated, restart the daemon and run it again.`);
		}

		return {
			sessionId: `c${cardId}-${label}-${attempt}`,
			kind: options.flow ? "flow_step" : "adhoc",
			shared: options.shared === true,
			attempt,
			model,
			thinking,
			tools: agent?.tools?.length ? agent.tools : toolsFor(step.access ?? (options.flow ? "read-only" : "write")),
			prompt,
			appendSystemPromptFiles,
			requireResult: options.requireResult,
			// A card with no worktree (research on a backlog card) works straight in the project checkout.
			...(card.worktreePath ? {} : { cwd: project?.repoPath }),
		};
	}

	private prompt(card: Card, step: FlowStep, reportPath: string | null): string {
		const { config } = this.deps;
		// pi expands /skill:name itself; an agent's role arrives as its system prompt, so the task is the whole prompt.
		if (step.skill) return `/skill:${step.skill}${step.task ? ` ${step.task}` : ""}`;
		if (step.agent) return step.task ?? `Do your job for this task: ${card.title}\n\n${card.brief}`;
		const cardDir = paths.cardDir(config, card.id);
		// A prompt file ships with Tower (prompts/flows) or belongs to a person's own flow (home/flows):
	// a flow in ~/.tower/flows references the .md files beside it.
	const read = (...parts: string[]) => {
		const shipped = join(config.promptsDir, ...parts);
		if (existsSync(shipped)) return readFileSync(shipped, "utf8");
		return readFileSync(join(config.home, ...parts), "utf8");
	};
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

/** The last line worth reading: gate feedback should carry the error, not just its exit code. */
function lastLine(output: string): string {
	const line = output
		.trimEnd()
		.split("\n")
		.filter((candidate) => candidate.trim() !== "" && !candidate.startsWith("[tower]"))
		.at(-1);
	return line ? ` — ${line.trim().slice(0, 200)}` : "";
}
