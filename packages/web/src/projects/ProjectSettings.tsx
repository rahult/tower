import type { Project } from "@tower/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { formatTokens } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { toast } from "../app/toasts.tsx";
import { field, monoField } from "../ui.ts";

type Settings = { setupCommand: string; verifyCommand: string; testCommand: string; previewCommand: string; previewUrl: string; previewCheck: string; concurrencyLimit: number; reviewFlows: string[] | null; invariantSimulation: boolean | null; subagents: boolean | null; understandBeforePlan: boolean | null; acceptanceGates: boolean | null };

/**
 * A project's levers, laid out as setting rows: verify and setup commands, hands-on test and preview
 * commands, review flows, invariant simulation and the concurrency cap. `autoSuggest` sends the agent
 * in the moment the form opens — the flow right after a project was added.
 */
export function ProjectSettings({ project, onDone, showSpend, autoSuggest }: { project: Project; onDone?: () => void; showSpend?: { runs: number; tokens: number; costUsd: number }; autoSuggest?: boolean }) {
	const [setupCommand, setSetupCommand] = useState(project.setupCommand ?? "");
	const [verifyCommand, setVerifyCommand] = useState(project.verifyCommand ?? "");
	const [testCommand, setTestCommand] = useState(project.testCommand ?? "");
	const [previewCommand, setPreviewCommand] = useState(project.previewCommand ?? "");
	const [previewUrl, setPreviewUrl] = useState(project.previewUrl ?? "");
	const [previewCheck, setPreviewCheck] = useState(project.previewCheck ?? "");
	const [concurrencyLimit, setConcurrencyLimit] = useState(project.concurrencyLimit);
	const flows = useQuery({ queryKey: ["flows"], queryFn: api.flows });
	const [reviewFlows, setReviewFlows] = useState<string[] | null>(project.reviewFlows);
	const chosen = reviewFlows ?? flows.data?.defaults ?? [];
	const daemonSettings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const [invariantSimulation, setInvariantSimulation] = useState<boolean | null>(project.invariantSimulation);
	const [subagents, setSubagents] = useState<boolean | null>(project.subagents);
	const [understandBeforePlan, setUnderstandBeforePlan] = useState<boolean | null>(project.understandBeforePlan);
	const [acceptanceGates, setAcceptanceGates] = useState<boolean | null>(project.acceptanceGates);
	const queryClient = useQueryClient();
	const save = useMutation({
		mutationFn: () => api.updateProject(project.id, { setupCommand, verifyCommand, testCommand, previewCommand, previewUrl, previewCheck, concurrencyLimit, reviewFlows, invariantSimulation, subagents, understandBeforePlan, acceptanceGates }),
		onSuccess: () => {
			toast(`Saved ${project.name}'s settings.`);
			void queryClient.invalidateQueries({ queryKey: ["board"] });
			onDone?.();
		},
	});

	// The system model: what a planner reads about this codebase before planning. Fresh, stale, or not
	// built yet — and a button to (re)build it, whose run lives on its own card.
	const model = useQuery({ queryKey: ["project-model", project.id], queryFn: () => api.projectModel(project.id), refetchInterval: 15_000 });
	const understand = useMutation({
		mutationFn: () => api.understand(project.id),
		onSuccess: (card) => {
			toast("Understanding the system — the run has its own card and the model lands here when it passes.");
			void queryClient.invalidateQueries({ queryKey: ["board"] });
			void card;
		},
		onError: (error: Error) => toast(error.message),
	});
	const modelText =
		model.data === undefined
			? "Checking…"
			: model.data.state === "missing"
				? "None yet — a planner reads only the code in front of it."
				: model.data.state === "fresh"
					? `Fresh${model.data.builtAt ? `, built ${new Date(model.data.builtAt).toLocaleDateString()} at ${model.data.commit?.slice(0, 10)}` : ""}.`
					: `Stale — the code has moved past ${model.data.commit?.slice(0, 10)} since it was built.`;

	// The agent reads the repository and drafts the commands. Only blank fields are filled, so a
	// considered verify command is never overwritten by a draft.
	const [draftNote, setDraftNote] = useState<string | null>(null);
	const probe = useMutation({
		mutationFn: () => api.suggestCommands(project.id),
		onSuccess: (draft) => {
			let filled = 0;
			const take = (current: string, suggestion: string | null, set: (v: string) => void) => {
				if (suggestion && !current.trim()) {
					set(suggestion);
					filled += 1;
				}
			};
			take(verifyCommand, draft.verify, setVerifyCommand);
			take(testCommand, draft.test, setTestCommand);
			take(setupCommand, draft.setup, setSetupCommand);
			take(previewCommand, draft.previewCommand, setPreviewCommand);
			take(previewUrl, draft.previewUrl, setPreviewUrl);
			setDraftNote(filled > 0 ? `The agent drafted ${filled} ${filled === 1 ? "command" : "commands"} — review and save.` : "The agent had nothing to add — the commands are already set.");
		},
	});
	const probePending = probe.isPending;
	const probeHere = () => {
		setDraftNote(null);
		probe.mutate();
	};
	useEffect(() => {
		if (autoSuggest) probe.mutate();
		// Once: the draft belongs to this opening of the form, not to every re-render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<form
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<div className="setting">
				<div>
					<div className="k">Commands</div>
					<div className="d">An agent can read the repository and draft these for you — verify, test, setup, preview. Review the draft, then save.</div>
				</div>
				<div className="v">
					<button type="button" className="btn" disabled={probePending} onClick={probeHere}>
						<Icon name="retry" />
						{probePending ? "Inspecting the repository…" : "Pre-fill with agent"}
					</button>
					{probePending && <span className="hint">A cheap session is reading {project.name}'s files — usually a few seconds.</span>}
					{draftNote && <span className="hint">{draftNote}</span>}
					{probe.error && <span className="error">{probe.error.message}</span>}
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">
						<label htmlFor={`verify-${project.id}`}>Verify command</label>
					</div>
					<div className="d">Runs in the card's worktree after each build. Its exit code decides whether testing passes; failures go back to the builder.</div>
				</div>
				<div className="v">
					<input id={`verify-${project.id}`} value={verifyCommand} onChange={(event) => setVerifyCommand(event.target.value)} placeholder="pnpm test && pnpm typecheck" className={monoField} />
					<span className="hint">{verifyCommand ? "Your tests decide." : "Empty: an agent judges builds. Set one to make tests the judge."}</span>
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">
						<label htmlFor={`test-${project.id}`}>Test command</label>
					</div>
					<div className="d">Yours to run from a card's Run tab, any time. Output streams into the card; it never passes or fails the card.</div>
				</div>
				<div className="v">
					<input id={`test-${project.id}`} value={testCommand} onChange={(event) => setTestCommand(event.target.value)} placeholder="pnpm test -- --watchAll=false" spellCheck={false} className={monoField} />
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">
						<label htmlFor={`preview-${project.id}`}>Preview command</label>
					</div>
					<div className="d">
						Starts a dev server in a card's worktree while you click through its branch{previewUrl ? ", answering at the preview URL" : ""}. The check command runs after it starts — exit 0 proves the URL is really serving this app, not whatever else holds the port.
					</div>
				</div>
				<div className="v grid gap-2 sm:grid-cols-2">
					<input id={`preview-${project.id}`} aria-label="Preview command" value={previewCommand} onChange={(event) => setPreviewCommand(event.target.value)} placeholder="pnpm dev" spellCheck={false} className={monoField} />
					<input aria-label="Preview URL" value={previewUrl} onChange={(event) => setPreviewUrl(event.target.value)} placeholder="http://localhost:5173" spellCheck={false} className={monoField} />
					<input aria-label="Preview check command" value={previewCheck} onChange={(event) => setPreviewCheck(event.target.value)} placeholder="node scripts/preview-check.mjs" spellCheck={false} className={`${monoField} sm:col-span-2`} />
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">
						<label htmlFor={`setup-${project.id}`}>Setup command</label>
					</div>
					<div className="d">Runs once when a card's worktree is created. New worktrees have no installed dependencies.</div>
				</div>
				<div className="v">
					<input id={`setup-${project.id}`} value={setupCommand} onChange={(event) => setSetupCommand(event.target.value)} placeholder="pnpm install --prefer-offline" className={monoField} />
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">Reviews after the tests pass</div>
					<div className="d">Each runs in a fresh session that never saw the builder's work, on your planning model. Their findings wait for you at the feedback gate.</div>
				</div>
				<div className="v">
					{flows.data?.flows.map((flow) => (
						<label key={flow.name} className="flex cursor-pointer items-start gap-2 text-[14px]">
							<input
								type="checkbox"
								className="mt-1 size-4 accent-[var(--primary)]"
								checked={chosen.includes(flow.name)}
								onChange={(event) => setReviewFlows(event.target.checked ? [...chosen, flow.name] : chosen.filter((name) => name !== flow.name))}
							/>
							<span>
								<span className="font-semibold">{flow.title}</span>
								<span className="block text-[13px] text-slate">{flow.description}</span>
							</span>
						</label>
					))}
					{!flows.data && <span className="hint">Loading the available reviews…</span>}
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">
						<label htmlFor={`invariants-${project.id}`}>Invariant simulation</label>
					</div>
					<div className="d">Planning models the work as domains, actors and invariants before code exists; testing verifies each invariant and reports a per-invariant verdict.</div>
				</div>
				<div className="v">
					<select
						id={`invariants-${project.id}`}
						value={invariantSimulation === null ? "default" : invariantSimulation ? "on" : "off"}
						onChange={(event) => setInvariantSimulation(event.target.value === "default" ? null : event.target.value === "on")}
						className={field}
					>
						<option value="default">Tower default{daemonSettings.data ? ` (${daemonSettings.data.invariantSimulation ? "on" : "off"})` : ""}</option>
						<option value="on">On for this project</option>
						<option value="off">Off for this project</option>
					</select>
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">
						<label htmlFor={`subagents-${project.id}`}>Parallel sub-agents</label>
					</div>
					<div className="d">When the plan splits the work, Tower fans it out: scouts answer questions in parallel, each stream is built by its own agent in its own worktree, and an integrator merges the branches before testing.</div>
				</div>
				<div className="v">
					<select
						id={`subagents-${project.id}`}
						value={subagents === null ? "default" : subagents ? "on" : "off"}
						onChange={(event) => setSubagents(event.target.value === "default" ? null : event.target.value === "on")}
						className={field}
					>
						<option value="default">Tower default{daemonSettings.data ? ` (${daemonSettings.data.subagents ? "on" : "off"})` : ""}</option>
						<option value="on">On for this project</option>
						<option value="off">Off for this project</option>
					</select>
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">System model</div>
					<div className="d">A read-only pass maps this codebase — domains, actors, state, invariants as built — so every planner starts from understanding, not guesswork.</div>
				</div>
				<div className="v">
					<p className="!mt-0 text-[14px]">{modelText}</p>
					<button type="button" className="btn sm" disabled={understand.isPending} onClick={() => understand.mutate()}>
						<Icon name="focus" />
						{understand.isPending ? "Understanding…" : model.data?.state === "missing" ? "Build the model" : "Rebuild the model"}
					</button>
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">
						<label htmlFor={`understand-${project.id}`}>Understand before plan</label>
					</div>
					<div className="d">When a card starts planning and the system model is missing or stale, Tower rebuilds it first — the plan is grounded in the system as it is now.</div>
				</div>
				<div className="v">
					<select
						id={`understand-${project.id}`}
						value={understandBeforePlan === null ? "default" : understandBeforePlan ? "on" : "off"}
						onChange={(event) => setUnderstandBeforePlan(event.target.value === "default" ? null : event.target.value === "on")}
						className={field}
					>
						<option value="default">Tower default{daemonSettings.data ? ` (${daemonSettings.data.understandBeforePlan ? "on" : "off"})` : ""}</option>
						<option value="on">On for this project</option>
						<option value="off">Off for this project</option>
					</select>
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">
						<label htmlFor={`acceptance-${project.id}`}>Acceptance gates</label>
					</div>
					<div className="d">Test-first, enforced: the plan ends with test targets, an agent turns them into failing specs before building, and a build only moves on when every spec passes. The repository needs an acceptance runner (the web-app archetype ships one).</div>
				</div>
				<div className="v">
					<select
						id={`acceptance-${project.id}`}
						value={acceptanceGates === null ? "default" : acceptanceGates ? "on" : "off"}
						onChange={(event) => setAcceptanceGates(event.target.value === "default" ? null : event.target.value === "on")}
						className={field}
					>
						<option value="default">Tower default{daemonSettings.data ? ` (${daemonSettings.data.acceptanceGates ? "on" : "off"})` : ""}</option>
						<option value="on">On for this project</option>
						<option value="off">Off for this project</option>
					</select>
				</div>
			</div>
			<div className="setting">
				<div>
					<div className="k">
						<label htmlFor={`concurrency-${project.id}`}>Cards at once</label>
					</div>
					<div className="d">How many of this project's cards may run at the same time. Each runs in its own worktree.</div>
				</div>
				<div className="v">
					<input id={`concurrency-${project.id}`} type="number" min={1} max={16} value={concurrencyLimit} onChange={(event) => setConcurrencyLimit(Number(event.target.value))} className={`${monoField} !w-24`} />
				</div>
			</div>
			{showSpend && (
				<div className="setting">
					<div>
						<div className="k">Spent, all time</div>
						<div className="d">Sessions Tower started for this project, with what they used.</div>
					</div>
					<div className="v">
						<span className="meta tnum">
							{showSpend.runs} {showSpend.runs === 1 ? "session" : "sessions"} · {formatTokens(showSpend.tokens)} tokens
							{showSpend.costUsd > 0 && ` · $${showSpend.costUsd.toFixed(2)}`}
						</span>
					</div>
				</div>
			)}
			<div className="flex items-center gap-3 px-4 py-3">
				<button type="submit" disabled={save.isPending} className="btn primary sm">
					{save.isPending ? "Saving…" : "Save settings"}
				</button>
				{onDone && (
					<button type="button" onClick={onDone} className="btn ghost sm">
						Close
					</button>
				)}
				{save.error && <span className="text-[14px] text-danger">{save.error.message}</span>}
			</div>
		</form>
	);
}
