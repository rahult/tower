import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	crewPaths,
	type Card,
	type CrewEntry,
	type CrewPlan,
	type Project,
	renderPrompt,
	resolveStageConfig,
	STAGE_RESULT_FILE,
	type StageModelConfig,
} from "@tower/core";
import { type Config, paths } from "./config.ts";
import type { Db } from "./db/open.ts";
import { runSetup } from "./git/setup.ts";
import { ensureStreamWorktree, type Worktree } from "./git/worktree-manager.ts";
import { toolsFor } from "./flows.ts";
import type { CustomRun, RunOutcome, StageRunner } from "./stage-runner.ts";

export interface CrewContext {
	card: Card;
	project: Project;
	/** The building attempt this crew belongs to; names every member session. */
	attempt: number;
	/** The card's worktree: scouts and the integrator work here, between the builders' own worktrees. */
	worktree: Worktree;
	crew: CrewPlan;
	/** Guidance carried by a retry or by answers to a previous attempt's questions. */
	feedback?: string;
	/**
	 * The ordinary building prompt, rendered by the StageRunner. A plan with streams replaces it with the
	 * crew; a plan with only scouts runs it as the crew's single builder, with the reports quoted in.
	 */
	fallbackPrompt: string;
}

export interface CrewRunnerDeps {
	config: Config;
	db: Db;
	/** Late-bound: the StageRunner is constructed with the crew runner inside it. */
	stages: () => StageRunner;
}

type SettledOutcome = Extract<RunOutcome, { kind: "settled" }>;
const passed = (outcome: RunOutcome): boolean => outcome.kind === "settled" && outcome.result === "pass";

/**
 * Runs one card's crew: the plan's scouts, then its stream builders — each builder in its own worktree, in
 * waves of `maxCrew` — and finally an integrator that merges the stream branches into the card's branch.
 * The whole crew is one building attempt: the card's lifecycle sees a single RunOutcome, exactly the shape
 * one builder would have produced.
 */
export class CrewRunner {
	private readonly deps: CrewRunnerDeps;

	constructor(deps: CrewRunnerDeps) {
		this.deps = deps;
	}

	async run(ctx: CrewContext): Promise<RunOutcome> {
		const { card, project, attempt, crew } = ctx;
		const label = `crew${attempt}`;
		const cardDir = paths.cardDir(this.deps.config, card.id);
		// Scouts write into research/, builders leave their verdicts in crew/: both exist before anyone runs.
		mkdirSync(join(cardDir, "research"), { recursive: true });
		mkdirSync(join(cardDir, "crew"), { recursive: true });
		const feedback = ctx.feedback ? `# Feedback on your previous attempt\n\n${ctx.feedback}` : "";

		// Every prompt is rendered before anything spawns (the update-safety rule): a template that cannot
		// render must fail the attempt cleanly, not leave spawned sessions undriven.
		let prompts: { scouts: string[]; builders: string[]; integrator: string | null };
		try {
			prompts = this.renderPrompts(ctx, cardDir, feedback);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`The crew prompts could not be rendered: ${reason}. If Tower was just updated, restart the daemon and retry the card.`);
		}

		// 1. Scouts, all at once and strictly advisory: a scout that crashes or comes back empty costs the
		//    builders a report, never the card its progress.
		if (prompts.scouts.length > 0) {
			const tier = this.tierFor(card, project, "planning");
			await Promise.all(
				crew.scouts.map((scout, index) =>
					this.spawn(card.id, {
						sessionId: `c${card.id}-${label}-scout-${scout.slug}`,
						kind: "subagent",
						attempt,
						model: tier.model,
						thinking: tier.thinking,
						tools: toolsFor("read-only"),
						prompt: prompts.scouts[index] as string,
						requireResult: false,
						shared: true,
					}).catch(() => undefined),
				),
			);
		}

		// 2. No streams: the crew is scouts plus the ordinary builder, whose verdict is the stage's.
		if (crew.streams.length === 0) {
			const tier = this.tierFor(card, project, "building");
			const research = prompts.scouts.length > 0 ? this.researchBlock(ctx.crew, cardDir) : "";
			return await this.spawn(card.id, {
				sessionId: `c${card.id}-${label}-builder`,
				kind: "subagent",
				attempt,
				model: tier.model,
				thinking: tier.thinking,
				tools: toolsFor("write"),
				prompt: `${ctx.fallbackPrompt}${research}`,
				requireResult: true,
				shared: true,
			});
		}

		// 3. Builders, in waves of maxCrew. A wave settles before the next launches, and a failure in one
		//    wave stops the later ones; the builders already running are left to finish — their verdicts are
		//    the attempt's record. Nobody is aborted from inside the crew: the card's abort is the one who does.
		const verdicts = new Map<string, RunOutcome>();
		for (let first = 0; first < crew.streams.length; first += this.deps.config.maxCrew) {
			if (verdicts.size > 0 && [...verdicts.values()].some((outcome) => !passed(outcome))) break;
			const wave = crew.streams.slice(first, first + this.deps.config.maxCrew).map((stream, index) => this.buildStream(ctx, stream, label, prompts.builders[first + index] as string, verdicts));
			await Promise.all(wave);
		}

		// 4. The verdict: one outcome, the same shape a single builder would have produced.
		const outcomes = crew.streams.map((stream) => verdicts.get(stream.slug)).filter((outcome): outcome is RunOutcome => outcome !== undefined);
		if (outcomes.some((outcome) => outcome.kind === "aborted")) return { kind: "aborted" };
		const crashed = outcomes.find((outcome) => outcome.kind === "failed");
		if (crashed) return crashed;
		if (outcomes.some((outcome) => !passed(outcome))) {
			const asked = outcomes.some((outcome) => outcome.kind === "settled" && outcome.hasQuestions);
			return {
				kind: "settled",
				stage: "building",
				result: asked ? "blocked" : "fail",
				summary: combine(streamVerdicts(crew.streams, verdicts)),
				hasQuestions: asked,
			};
		}

		// 5. Integrator: merges the stream branches into the card's branch, in the card's worktree.
		const tier = this.tierFor(card, project, "building");
		return await this.spawn(card.id, {
			sessionId: `c${card.id}-${label}-integrator`,
			kind: "subagent",
			attempt,
			model: tier.model,
			thinking: tier.thinking,
			tools: toolsFor("write"),
			prompt: prompts.integrator as string,
			requireResult: true,
			shared: true,
		});
	}

	/** Builds one stream in its own worktree and records the outcome under the stream's slug. */
	private async buildStream(ctx: CrewContext, stream: CrewEntry, label: string, prompt: string, verdicts: Map<string, RunOutcome>): Promise<void> {
		const { card, project, worktree, attempt } = ctx;
		const { config } = this.deps;
		try {
			// Stream worktrees are siblings of the card's own, so they can be listed and removed beside it.
			const path = join(dirname(paths.worktree(config, project.id, card.id)), `${card.id}-ws-${stream.slug}`);
			const ws = await ensureStreamWorktree({ repoPath: project.repoPath, path, branchName: `tower/${card.id}-ws-${stream.slug}`, baseCommit: worktree.baseCommit });
			// A brand-new stream worktree has no installed dependencies, like any new worktree.
			if (ws.created && project.setupCommand) await runSetup(project.setupCommand, ws.path);
			const tier = this.tierFor(card, project, "building");
			verdicts.set(
				stream.slug,
				await this.spawn(card.id, {
					sessionId: `c${card.id}-${label}-ws-${stream.slug}`,
					kind: "subagent",
					attempt,
					model: tier.model,
					thinking: tier.thinking,
					tools: toolsFor("write"),
					prompt,
					requireResult: true,
					shared: true,
					resultPath: crewPaths.builderResult(stream.slug),
					cwd: ws.path,
				}),
			);
		} catch (error) {
			verdicts.set(stream.slug, { kind: "failed", error: error instanceof Error ? error.message : String(error) });
		}
	}

	private spawn(cardId: string, request: CustomRun): Promise<RunOutcome> {
		return this.deps.stages().startCustom(cardId, request);
	}

	/** Members follow the person's model settings: scouts and analysts like the planners, builders like builds. */
	private tierFor(card: Card, project: Project, stage: "planning" | "building"): StageModelConfig {
		return resolveStageConfig(stage, { card: card.stageConfig, project: project.stageConfig, global: this.deps.config.globalStageConfig });
	}

	private researchBlock(crew: CrewPlan, cardDir: string): string {
		const reports = crew.scouts.map((scout) => `- \`${join(cardDir, crewPaths.scoutReport(scout.slug))}\` — ${firstClause(scout.text)}`).join("\n");
		return `\n\n# Research from the scouts\n\nScouts investigated this task before you began. Read any of these reports that exist, and honor what they find:\n\n${reports}\n`;
	}

	/**
	 * Renders every crew prompt, straight from disk like every template in Tower. The integrator's merge
	 * list is deterministic (branches are named after the streams), so all prompts can exist before the
	 * first session does.
	 */
	private renderPrompts(ctx: CrewContext, cardDir: string, feedback: string): { scouts: string[]; builders: string[]; integrator: string | null } {
		const { config } = this.deps;
		const read = (...parts: string[]) => readFileSync(join(config.promptsDir, ...parts), "utf8");
		const contract = read("partials", "stage-result-contract.md");
		const common = {
			title: ctx.card.title,
			brief: ctx.card.brief || "(no further description)",
			planPath: join(cardDir, "plan.md"),
			feedbackSection: feedback,
		};
		const streamPrompt = (stream: CrewEntry) =>
			renderPrompt(
				read("subagents", "builder.md"),
				{
					...common,
					worktreePath: join(dirname(paths.worktree(config, ctx.project.id, ctx.card.id)), `${ctx.card.id}-ws-${stream.slug}`),
					branchName: `tower/${ctx.card.id}-ws-${stream.slug}`,
					stream: stream.text,
					scoutReports: ctx.crew.scouts.length > 0 ? this.researchBlock(ctx.crew, cardDir).trim() : "No scouts were sent for this task.",
					resultPath: join(cardDir, crewPaths.builderResult(stream.slug)),
				},
				{ "stage-result-contract": contract },
			);
		return {
			scouts: ctx.crew.scouts.map((scout) =>
				renderPrompt(read("subagents", "scout.md"), { ...common, question: scout.text, worktreePath: ctx.worktree.path, reportPath: join(cardDir, crewPaths.scoutReport(scout.slug)) }),
			),
			builders: ctx.crew.streams.map(streamPrompt),
			integrator:
				ctx.crew.streams.length > 0
					? renderPrompt(
							read("subagents", "integrator.md"),
							{
								...common,
								streamCount: String(ctx.crew.streams.length),
								worktreePath: ctx.worktree.path,
								branchName: ctx.worktree.branchName,
								streamList: ctx.crew.streams.map((stream) => `- \`tower/${ctx.card.id}-ws-${stream.slug}\` — stream **${stream.slug}**`).join("\n"),
								cardDir,
								resultPath: join(cardDir, STAGE_RESULT_FILE),
							},
							{ "stage-result-contract": contract },
						)
					: null,
		};
	}
}

function streamVerdicts(streams: CrewEntry[], verdicts: Map<string, RunOutcome>): string[] {
	return streams
		.map((stream) => {
			const outcome = verdicts.get(stream.slug);
			if (!outcome) return null;
			if (outcome.kind === "failed") return `stream ${stream.slug} crashed: ${outcome.error}`;
			if (outcome.kind === "aborted") return `stream ${stream.slug} was stopped`;
			return `stream ${stream.slug}: ${outcome.summary}`;
		})
		.filter((part): part is string => part !== null);
}

function combine(parts: string[]): string {
	return parts.join(" ");
}

function firstClause(text: string): string {
	const sentence = text.split(/[.\n]/)[0] ?? text;
	return sentence.length > 90 ? `${sentence.slice(0, 87)}…` : sentence;
}
