import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api, type Settings } from "../api/client.ts";

const STAGES = [
	{ stage: "planning", label: "Planning", hint: "Explores the repository and writes the plan. Worth a strong model: a cheap builder inherits its mistakes." },
	{ stage: "building", label: "Building", hint: "Writes the code from the plan. Most of the tokens are spent here." },
	{ stage: "testing", label: "Testing", hint: "Only used for projects without a verify command, where an agent judges the build." },
] as const;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type Draft = Record<string, { model: string; thinking: string }>;

const toDraft = (settings: Settings): Draft => Object.fromEntries(STAGES.map(({ stage }) => [stage, { model: settings.models[stage].model, thinking: settings.models[stage].thinking }]));

/** Which model runs each stage. Saved to ~/.tower/config.json and used by the next session that starts. */
export function ModelSettings({ onDone }: { onDone: () => void }) {
	const queryClient = useQueryClient();
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const [draft, setDraft] = useState<Draft | null>(null);
	useEffect(() => {
		if (settings.data && !draft) setDraft(toDraft(settings.data));
	}, [settings.data, draft]);
	const save = useMutation({
		mutationFn: (models: Draft) => api.saveSettings(models),
		onSuccess: (saved) => {
			queryClient.setQueryData(["settings"], saved);
			onDone();
		},
	});

	if (settings.error) return <p className="mb-3 rounded-[3px] bg-rose px-3 py-2 text-ink">{settings.error.message}</p>;
	if (!settings.data || !draft) return <p className="mb-3 text-[14px] text-dust">Loading models…</p>;
	const field = "rounded-[3px] bg-well px-3 py-1.5 font-mono text-[13px] placeholder:text-dust/60";
	const set = (stage: string, patch: Partial<Draft[string]>) => setDraft({ ...draft, [stage]: { ...(draft[stage] as Draft[string]), ...patch } });

	return (
		<form
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				save.mutate(draft);
			}}
			className="mb-4 max-w-[62rem] rounded-md bg-rack p-4"
		>
			<h2 className="text-[17px] font-semibold">Models</h2>
			<p className="mt-1 mb-3 max-w-[70ch] text-[14px] text-dust">
				Use pi's <span className="font-mono text-[13px]">provider/model</span> names. Changes apply to the next session that starts; a card can still override them. Saved to{" "}
				<span className="font-mono text-[13px]">{settings.data.file}</span>.
			</p>
			<datalist id="known-models">
				{settings.data.knownModels.map((name) => (
					<option key={name} value={name} />
				))}
			</datalist>
			<div className="flex flex-col gap-3">
				{STAGES.map(({ stage, label, hint }) => (
					<div key={stage} className="grid gap-x-3 gap-y-1 sm:grid-cols-[7rem_minmax(0,1fr)_9rem]">
						<label htmlFor={`model-${stage}`} className="pt-1.5 font-semibold">
							{label}
						</label>
						<input
							id={`model-${stage}`}
							list="known-models"
							value={draft[stage]?.model ?? ""}
							onChange={(event) => set(stage, { model: event.target.value })}
							spellCheck={false}
							className={field}
						/>
						<select aria-label={`${label} thinking level`} value={draft[stage]?.thinking} onChange={(event) => set(stage, { thinking: event.target.value })} className={field}>
							{THINKING.map((level) => (
								<option key={level} value={level}>
									thinking {level}
								</option>
							))}
						</select>
						<p className="text-[13px] text-dust sm:col-start-2 sm:col-end-4">{hint}</p>
					</div>
				))}
			</div>
			<div className="mt-4 flex items-center gap-3">
				<button type="submit" disabled={save.isPending} className="condensed cursor-pointer rounded-[3px] bg-chalk px-3 py-1.5 font-semibold text-ink hover:bg-white disabled:opacity-40">
					Save models
				</button>
				{save.error && <span className="text-[14px] text-rose">{save.error.message}</span>}
			</div>
		</form>
	);
}
