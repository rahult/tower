import type { Project } from "@tower/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { formatTokens } from "../app/bits.tsx";
import { toast } from "../app/toasts.tsx";
import { field, monoField } from "../ui.ts";

type Settings = { setupCommand: string; verifyCommand: string; testCommand: string; previewCommand: string; previewUrl: string; concurrencyLimit: number; reviewFlows: string[] | null; invariantSimulation: boolean | null; subagents: boolean | null };

/**
 * A project's levers, laid out as setting rows: verify and setup commands, hands-on test and preview
 * commands, review flows, invariant simulation and the concurrency cap. Lives inline on the project's
 * sheet; `onDone` collapses it again where it opens in place (a board lane).
 */
export function ProjectSettings({ project, onDone, showSpend }: { project: Project; onDone?: () => void; showSpend?: { runs: number; tokens: number; costUsd: number } }) {
	const [setupCommand, setSetupCommand] = useState(project.setupCommand ?? "");
	const [verifyCommand, setVerifyCommand] = useState(project.verifyCommand ?? "");
	const [testCommand, setTestCommand] = useState(project.testCommand ?? "");
	const [previewCommand, setPreviewCommand] = useState(project.previewCommand ?? "");
	const [previewUrl, setPreviewUrl] = useState(project.previewUrl ?? "");
	const [concurrencyLimit, setConcurrencyLimit] = useState(project.concurrencyLimit);
	const flows = useQuery({ queryKey: ["flows"], queryFn: api.flows });
	const [reviewFlows, setReviewFlows] = useState<string[] | null>(project.reviewFlows);
	const chosen = reviewFlows ?? flows.data?.defaults ?? [];
	const daemonSettings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const [invariantSimulation, setInvariantSimulation] = useState<boolean | null>(project.invariantSimulation);
	const [subagents, setSubagents] = useState<boolean | null>(project.subagents);
	const save = useMutation({
		mutationFn: () => api.updateProject(project.id, { setupCommand, verifyCommand, testCommand, previewCommand, previewUrl, concurrencyLimit, reviewFlows, invariantSimulation, subagents }),
		onSuccess: () => {
			toast(`Saved ${project.name}'s settings.`);
			onDone?.();
		},
	});
	return (
		<form
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				save.mutate();
			}}
		>
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
						Starts a dev server in a card's worktree while you click through its branch{previewUrl ? ", answering at the preview URL" : ""}. Set both from a card's Run tab.
					</div>
				</div>
				<div className="v grid gap-2 sm:grid-cols-2">
					<input id={`preview-${project.id}`} aria-label="Preview command" value={previewCommand} onChange={(event) => setPreviewCommand(event.target.value)} placeholder="pnpm dev" spellCheck={false} className={monoField} />
					<input aria-label="Preview URL" value={previewUrl} onChange={(event) => setPreviewUrl(event.target.value)} placeholder="http://localhost:5173" spellCheck={false} className={monoField} />
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
