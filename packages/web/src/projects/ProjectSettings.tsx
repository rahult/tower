import type { Project } from "@tower/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { button, field, monoField } from "../ui.ts";

type Settings = { setupCommand: string; verifyCommand: string; testCommand: string; previewCommand: string; previewUrl: string; concurrencyLimit: number; reviewFlows: string[] | null; invariantSimulation: boolean | null };

/** Verify and setup commands, hands-on test and preview commands, review flows and the concurrency cap. Shared by the board lane and the Projects view. */
export function ProjectSettings({ project, onDone }: { project: Project; onDone: () => void }) {
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
	const save = useMutation({ mutationFn: () => api.updateProject(project.id, { setupCommand, verifyCommand, testCommand, previewCommand, previewUrl, concurrencyLimit, reviewFlows, invariantSimulation }), onSuccess: onDone });
	return (
		<form
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				save.mutate();
			}}
			className="flex max-w-[60ch] flex-col gap-4"
		>
			<label className="block font-semibold">
				Verify command
				<span className="block text-[13px] font-normal text-slate">Runs in the card's worktree after each build. Its exit code decides whether testing passes; failures go back to the builder.</span>
				<input value={verifyCommand} onChange={(event) => setVerifyCommand(event.target.value)} placeholder="pnpm test && pnpm typecheck" className={`mt-1 ${monoField}`} />
			</label>
			<fieldset className="rounded-lg border border-rule p-3">
				<legend className="px-1 font-semibold">Hands-on commands</legend>
				<p className="text-[13px] text-slate">Yours to run from a card's Run tab, any time. What these look like depends on the stack, so each project says for itself.</p>
				<label className="mt-2 block font-semibold">
					Test command
					<span className="block text-[13px] font-normal text-slate">Run on demand against a card's worktree. Output streams into the card; it never passes or fails the card.</span>
					<input value={testCommand} onChange={(event) => setTestCommand(event.target.value)} placeholder="pnpm test -- --watchAll=false" spellCheck={false} className={`mt-1 ${monoField}`} />
				</label>
				<label className="mt-3 block font-semibold">
					Preview command
					<span className="block text-[13px] font-normal text-slate">Starts a dev server in the card's worktree and keeps it alive while you click through this card's branch.</span>
					<input value={previewCommand} onChange={(event) => setPreviewCommand(event.target.value)} placeholder="pnpm dev" spellCheck={false} className={`mt-1 ${monoField}`} />
				</label>
				<label className="mt-3 block font-semibold">
					Preview URL
					<span className="block text-[13px] font-normal text-slate">Where that server answers, opened from the card while the preview runs.</span>
					<input value={previewUrl} onChange={(event) => setPreviewUrl(event.target.value)} placeholder="http://localhost:5173" spellCheck={false} className={`mt-1 ${monoField}`} />
				</label>
			</fieldset>
			<label className="block font-semibold">
				Setup command
				<span className="block text-[13px] font-normal text-slate">Runs once when a card's worktree is created. New worktrees have no installed dependencies.</span>
				<input value={setupCommand} onChange={(event) => setSetupCommand(event.target.value)} placeholder="pnpm install --prefer-offline" className={`mt-1 ${monoField}`} />
			</label>
			<fieldset>
				<legend className="font-semibold">Reviews after the tests pass</legend>
				<p className="text-[13px] text-slate">Each runs in a fresh session that never saw the builder's work, on your planning model. Their findings wait for you at the feedback gate.</p>
				<div className="mt-1.5 flex flex-col gap-1">
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
				</div>
			</fieldset>
			<label className="block font-semibold">
				Invariant simulation
				<span className="block text-[13px] font-normal text-slate">
					Planning models the work as domains, actors and invariants before code exists; testing verifies each invariant and reports a per-invariant verdict. The invariant-simulation flow stays available from a card's drawer either way.
				</span>
				<select
					value={invariantSimulation === null ? "default" : invariantSimulation ? "on" : "off"}
					onChange={(event) => setInvariantSimulation(event.target.value === "default" ? null : event.target.value === "on")}
					className={`mt-1 ${field}`}
				>
					<option value="default">Tower default{daemonSettings.data ? ` (${daemonSettings.data.invariantSimulation ? "on" : "off"})` : ""}</option>
					<option value="on">On for this project</option>
					<option value="off">Off for this project</option>
				</select>
			</label>
			<label className="block font-semibold">
				Cards at once
				<span className="block text-[13px] font-normal text-slate">How many of this project's cards may run at the same time. Each runs in its own worktree.</span>
				<input type="number" min={1} max={16} value={concurrencyLimit} onChange={(event) => setConcurrencyLimit(Number(event.target.value))} className={`mt-1 !w-24 ${monoField}`} />
			</label>
			<div className="flex items-center gap-3">
				<button type="submit" disabled={save.isPending} className={button.primary}>
					Save settings
				</button>
				{save.error && <span className="text-[14px] text-danger">{save.error.message}</span>}
			</div>
		</form>
	);
}
