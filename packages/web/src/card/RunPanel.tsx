import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { button, field, monoField } from "../ui.ts";

const KINDS = [
	{ kind: "flow", label: "Review flow", hint: "A shipped or custom flow, such as an adversarial or SOLID review." },
	{ kind: "skill", label: "pi skill", hint: "Any skill pi knows, by name: code-review, grilling, tdd…" },
	{ kind: "agent", label: "Agent role", hint: "One of your ~/.pi/agent/agents files. Its model, tools and role are used." },
	{ kind: "prompt", label: "Prompt", hint: "Anything you want done in this card's worktree." },
] as const;
type Kind = (typeof KINDS)[number]["kind"];

/** Run something against this card on demand. The card keeps its place; the run shows up under Session. */
export function RunPanel({ cardId, busy, onStarted }: { cardId: string; busy: boolean; onStarted: () => void }) {
	const [kind, setKind] = useState<Kind>("flow");
	const [name, setName] = useState("");
	const [text, setText] = useState("");
	const [model, setModel] = useState("");
	const [access, setAccess] = useState("read-only");
	const flows = useQuery({ queryKey: ["flows"], queryFn: api.flows });
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const flowName = name || flows.data?.flows[0]?.name || "";
	const run = useMutation({
		mutationFn: () =>
			api.adhoc(cardId, {
				...(kind === "flow" ? { flow: flowName } : kind === "prompt" ? { prompt: text.trim(), access } : { [kind]: name.trim(), task: text.trim() || undefined }),
				model: kind === "flow" ? undefined : model.trim() || undefined,
			}),
		onSuccess: onStarted,
	});
	const ready = kind === "flow" ? flowName !== "" : kind === "prompt" ? text.trim() !== "" : name.trim() !== "";

	return (
		<form
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				if (ready && !busy) run.mutate();
			}}
			className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-sheet p-4"
		>
			<fieldset className="flex flex-wrap gap-1.5">
				<legend className="mb-2 font-semibold">What to run</legend>
				{KINDS.map((option) => (
					<label key={option.kind} className={`cursor-pointer rounded-md border px-3 py-1.5 text-[14px] ${kind === option.kind ? "border-primary bg-primary-soft font-semibold" : "border-rule hover:bg-wash"}`}>
						<input type="radio" name="kind" className="sr-only" checked={kind === option.kind} onChange={() => (setKind(option.kind), setName(""))} />
						{option.label}
					</label>
				))}
			</fieldset>
			<p className="-mt-2 text-[13px] text-slate">{KINDS.find((option) => option.kind === kind)?.hint}</p>

			{kind === "flow" ? (
				<label className="block font-semibold">
					Flow
					<select value={flowName} onChange={(event) => setName(event.target.value)} className={`mt-1 ${field}`}>
						{flows.data?.flows.map((flow) => (
							<option key={flow.name} value={flow.name}>
								{flow.title}
							</option>
						))}
					</select>
					<span className="mt-1 block text-[13px] font-normal text-slate">{flows.data?.flows.find((flow) => flow.name === flowName)?.description}</span>
				</label>
			) : (
				kind !== "prompt" && (
					<label className="block font-semibold">
						{kind === "skill" ? "Skill name" : "Agent name"}
						<input value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "skill" ? "code-review" : "reviewer"} spellCheck={false} className={`mt-1 ${monoField}`} />
					</label>
				)
			)}

			{kind !== "flow" && (
				<label className="block font-semibold">
					{kind === "prompt" ? "Prompt" : kind === "skill" ? "Arguments (optional)" : "Task (optional)"}
					<textarea value={text} onChange={(event) => setText(event.target.value)} rows={kind === "prompt" ? 5 : 2} className={`mt-1 ${field} resize-y font-normal`} placeholder={kind === "prompt" ? "Find every place that swallows an error and list them." : ""} />
				</label>
			)}

			{kind !== "flow" && (
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="block font-semibold">
						Model
						<input value={model} onChange={(event) => setModel(event.target.value)} list="run-models" placeholder={kind === "agent" ? "the role's own model" : (settings.data?.models.planning.model ?? "")} spellCheck={false} className={`mt-1 ${monoField}`} />
						<datalist id="run-models">{settings.data?.knownModels.map((known) => <option key={known} value={known} />)}</datalist>
					</label>
					{kind === "prompt" && (
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
