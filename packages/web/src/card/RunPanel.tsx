import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import type { Project } from "@tower/core";
import { type Preview, api } from "../api/client.ts";
import { button, field, monoField } from "../ui.ts";

const KINDS = [
	{ kind: "flow", label: "Review flow", hint: "A shipped or custom flow — a review, deep research, or your own pipeline of agent steps and shell gates." },
	{ kind: "skill", label: "pi skill", hint: "Any skill pi knows, by name: code-review, grilling, tdd…" },
	{ kind: "agent", label: "Agent role", hint: "One of your ~/.pi/agent/agents files. Its model, tools and role are used." },
	{ kind: "prompt", label: "Prompt", hint: "Anything you want done in this card's worktree." },
] as const;
type Kind = (typeof KINDS)[number]["kind"];

const TRIGGER_LABEL: Record<string, string> = { "after-plan": "after the plan", "after-build": "after the build", "after-tests": "after tests" };

/**
 * Run something against this card on demand. The card keeps its place; runs show up under Session.
 * On top of the agent runs sit the hands-on controls: the project's tests, and a preview to click through.
 * A card with no worktree (backlog) may still run read-only flows — research before the work starts.
 */
export function RunPanel({ cardId, project, hasWorktree, bench, busy, onStarted }: { cardId: string; project: Project | undefined; hasWorktree: boolean; bench: Preview | undefined; busy: boolean; onStarted: () => void }) {
	const queryClient = useQueryClient();
	const refreshCard = () => void queryClient.invalidateQueries({ queryKey: ["card", cardId] });
	const tests = useMutation({ mutationFn: () => api.runTests(cardId), onSuccess: onStarted });
	const preview = useMutation({ mutationFn: () => (bench?.running ? api.stopPreview(cardId) : api.startPreview(cardId)), onSuccess: refreshCard });
	// A test run takes the card's one run lease, so it waits for a session; a preview never takes one.
	const testDisabled = busy || tests.isPending;
	const previewBusy = preview.isPending;
	const testReady = !!project?.testCommand;
	const previewReady = !!project?.previewCommand;
	const [kind, setKind] = useState<Kind>("flow");
	const [name, setName] = useState("");
	const [text, setText] = useState("");
	const [model, setModel] = useState("");
	const [access, setAccess] = useState("read-only");
	const flows = useQuery({ queryKey: ["flows"], queryFn: api.flows });
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const flowName = name || flows.data?.flows[0]?.name || "";
	// Without a worktree only read-only flows run — everything else waits for the card to start.
	const kinds = hasWorktree ? KINDS : KINDS.filter((option) => option.kind === "flow");
	const activeKind: Kind = kinds.some((option) => option.kind === kind) ? kind : "flow";
	const run = useMutation({
		mutationFn: () =>
			api.adhoc(cardId, {
				...(activeKind === "flow" ? { flow: flowName } : activeKind === "prompt" ? { prompt: text.trim(), access } : { [activeKind]: name.trim(), task: text.trim() || undefined }),
				model: activeKind === "flow" ? undefined : model.trim() || undefined,
			}),
		onSuccess: onStarted,
	});
	const ready = activeKind === "flow" ? flowName !== "" : activeKind === "prompt" ? text.trim() !== "" : name.trim() !== "";

	return (
		<form
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				if (ready && !busy) run.mutate();
			}}
			className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-sheet p-4"
		>
			<section aria-label="Hands on" className="flex flex-col gap-4 rounded-lg border border-rule bg-wash/50 p-4">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<div className="min-w-0 flex-1">
						<h3 className="font-semibold">Hands on</h3>
						<p className="text-[13px] text-slate">
							{testReady ? (
								<>
									Run <span className="font-mono">{project?.testCommand}</span> in this card's worktree. The output streams under Session; it never passes or fails the card.
								</>
							) : (
								<>No test command is set for {project?.name ?? "this project"} — add one in its project settings.</>
							)}
						</p>
					</div>
					<button type="button" disabled={!testReady || testDisabled} onClick={() => tests.mutate()} className={button.primary}>
						{tests.isPending ? "Starting…" : "Run tests"}
					</button>
					{tests.error && <span className="text-[13px] text-danger">{tests.error.message}</span>}
				</div>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-rule pt-4">
					<div className="min-w-0 flex-1">
						<h3 className="font-semibold">Preview</h3>
						<p className="text-[13px] text-slate">
							{!previewReady ? (
								<>No preview command is set for {project?.name ?? "this project"} — add one in its project settings.</>
							) : bench?.running ? (
								<>
									<span className="mr-1.5 inline-block size-2 rounded-full bg-ok align-middle" aria-hidden />
									Running <span className="font-mono">{bench.command}</span> against this card's branch
									{bench.url ? (
										<>
											{" "}
											at <a href={bench.url} target="_blank" rel="noreferrer noopener" className="font-semibold text-primary underline underline-offset-4">{bench.url}</a>
										</>
									) : null}
									.
								</>
							) : (
								<>
									Starts <span className="font-mono">{project?.previewCommand}</span> in this card's worktree{project?.previewUrl ? `, serving ${project.previewUrl}` : ""}.
								</>
							)}
						</p>
					</div>
					{bench?.running ? (
						<button type="button" disabled={previewBusy} onClick={() => preview.mutate()} className={button.quiet}>
							{previewBusy ? "Stopping…" : "Stop preview"}
						</button>
					) : (
						<button type="button" disabled={!previewReady || previewBusy} onClick={() => preview.mutate()} className={button.primary}>
							{previewBusy ? "Starting…" : "Start preview"}
						</button>
					)}
					{preview.error && <span className="text-[13px] text-danger">{preview.error.message}</span>}
				</div>
			</section>

			<fieldset className="flex flex-wrap gap-1.5">
				<legend className="mb-2 font-semibold">What to run</legend>
				{kinds.map((option) => (
					<label key={option.kind} className={`cursor-pointer rounded-md border px-3 py-1.5 text-[14px] ${activeKind === option.kind ? "border-primary bg-primary-soft font-semibold" : "border-rule hover:bg-wash"}`}>
						<input type="radio" name="kind" className="sr-only" checked={activeKind === option.kind} onChange={() => (setKind(option.kind), setName(""))} />
						{option.label}
					</label>
				))}
			</fieldset>
			<p className="-mt-2 text-[13px] text-slate">
				{kinds.find((option) => option.kind === activeKind)?.hint}
				{!hasWorktree && " This card has no worktree yet, so only read-only flows run here — start it for everything else."}
			</p>

			{activeKind === "flow" ? (
				<label className="block font-semibold">
					Flow
					<select value={flowName} onChange={(event) => setName(event.target.value)} className={`mt-1 ${field}`}>
						{flows.data?.flows.map((flow) => {
							const hooks = flow.when.filter((trigger) => trigger !== "manual").map((trigger) => TRIGGER_LABEL[trigger] ?? trigger);
							return (
								<option key={flow.name} value={flow.name}>
									{flow.title}
									{hooks.length > 0 ? ` — runs ${hooks.join(" and ")}` : ""}
								</option>
							);
						})}
					</select>
					<span className="mt-1 block text-[13px] font-normal text-slate">{flows.data?.flows.find((flow) => flow.name === flowName)?.description}</span>
				</label>
			) : (
				activeKind !== "prompt" && (
					<label className="block font-semibold">
						{activeKind === "skill" ? "Skill name" : "Agent name"}
						<input value={name} onChange={(event) => setName(event.target.value)} placeholder={activeKind === "skill" ? "code-review" : "reviewer"} spellCheck={false} className={`mt-1 ${monoField}`} />
					</label>
				)
			)}

			{activeKind !== "flow" && (
				<label className="block font-semibold">
					{activeKind === "prompt" ? "Prompt" : activeKind === "skill" ? "Arguments (optional)" : "Task (optional)"}
					<textarea value={text} onChange={(event) => setText(event.target.value)} rows={activeKind === "prompt" ? 5 : 2} className={`mt-1 ${field} resize-y font-normal`} placeholder={activeKind === "prompt" ? "Find every place that swallows an error and list them." : ""} />
				</label>
			)}

			{activeKind !== "flow" && (
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="block font-semibold">
						Model
						<input value={model} onChange={(event) => setModel(event.target.value)} list="run-models" placeholder={activeKind === "agent" ? "the role's own model" : (settings.data?.models.planning.model ?? "")} spellCheck={false} className={`mt-1 ${monoField}`} />
						<datalist id="run-models">{settings.data?.knownModels.map((known) => <option key={known} value={known} />)}</datalist>
						{model.trim() !== "" && !new Set(settings.data?.knownModels ?? []).has(model.trim()) && (
							<span className="mt-1 block text-[13px] font-normal text-caution-text">Not in pi's known models — the run will fail unless the name is exact.</span>
						)}
					</label>
					{activeKind === "prompt" && (
						<label className="block font-semibold">
							It may
							<select value={access} onChange={(event) => setAccess(event.target.value)} className={`mt-1 ${field}`}>
								<option value="read-only">read the code</option>
								<option value="read-and-run">read and run commands</option>
								<option value="write">change the code</option>
							</select>
						</label>
					)}
				</div>
			)}

			<div className="flex flex-wrap items-center gap-3">
				<button type="submit" disabled={!ready || busy || run.isPending} className={button.primary}>
					Run it
				</button>
				{busy && <span className="text-[13px] text-slate">Something is already running for this card.</span>}
				{run.error && <span className="text-[14px] text-danger">{run.error.message}</span>}
			</div>
		</form>
	);
}
