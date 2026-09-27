import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, type FlowInfo, type FlowStepInfo } from "../api/client.ts";
import { ErrorNote } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { toast } from "../app/toasts.tsx";
import { field, monoField } from "../ui.ts";
import { type Edge, flowEdges, freeStepName, KIND_LABEL, nextTarget, removeStep, renameStep, stepKind, type StepKind, unreachableNodes } from "./graph.ts";
import { FlowGraph } from "./FlowGraph.tsx";

const TRIGGERS = ["manual", "after-plan", "after-build", "after-tests", "schedule"] as const;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ACCESSES = ["read-only", "read-and-run", "write", "probe"] as const;
const NAME_OK = /^[a-z0-9][a-z0-9-]*$/;

interface FlowEditorProps {
	initial: FlowInfo;
	onClose: () => void;
}

/** Strip the fields a kind leaves behind, so a node never carries two actions at once. */
function withKind(step: FlowStepInfo, kind: StepKind): FlowStepInfo {
	const base = { name: step.name, ...(step.access ? { access: step.access } : {}), ...(step.maxRuns ? { maxRuns: step.maxRuns } : {}), ...(step.on && Object.keys(step.on).length ? { on: step.on } : {}) };
	switch (kind) {
		case "command":
			return { ...base, run: step.run ?? "true", ...(step.expect ? { expect: step.expect } : {}), ...(step.timeoutSec ? { timeoutSec: step.timeoutSec } : {}) };
		case "text":
			return { ...base, text: step.text ?? "" };
		case "prompt":
			return { ...base, prompt: step.prompt ?? "" };
		case "skill":
			return { ...base, skill: step.skill ?? "", ...(step.task ? { task: step.task } : {}) };
		case "agent":
			return { ...base, agent: step.agent ?? "", ...(step.task ? { task: step.task } : {}) };
	}
}

/**
 * The flow editor: a canvas of nodes wired by verdict, an inspector for the selected node's fields,
 * and the meta (name, triggers) in the header. A shipped flow opens read-only until duplicated.
 */
export function FlowEditor({ initial, onClose }: FlowEditorProps) {
	const readOnly = initial.source === "shipped";
	const [flow, setFlow] = useState<FlowInfo>(initial);
	const [selected, setSelected] = useState<string | null>(flow.steps[0]?.name ?? null);
	const [showJson, setShowJson] = useState(false);
	const [jsonDraft, setJsonDraft] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	const step = flow.steps.find((candidate) => candidate.name === selected) ?? null;
	const start = flow.start ?? flow.steps[0]?.name;
	const broken = unreachableNodes(flow);

	const save = useMutation({
		mutationFn: (next: FlowInfo) => api.saveFlow(next),
		onSuccess: async ({ overridden }, next) => {
			setProblem(null);
			setFlow({ ...next, source: "custom" });
			// A rename is a new file; the person's old copy would linger unnamed in the Run tab.
			if (initial.source === "custom" && initial.name !== next.name) await api.deleteFlow(initial.name).catch(() => {});
			toast(overridden ? `Saved — "${next.name}" now overrides the shipped flow.` : `Saved "${next.name}" to your flows.`);
		},
		onError: (error: Error) => setProblem(error.message),
	});

	const update = (patch: Partial<FlowInfo>) => setFlow((current) => ({ ...current, ...patch }));
	const updateStep = (name: string, patch: Partial<FlowStepInfo>) => setFlow((current) => ({ ...current, steps: current.steps.map((s) => (s.name === name ? { ...s, ...patch } : s)) }));
	const removeStepAt = (name: string) =>
		setFlow((current) => {
			const next = removeStep(current, name);
			if (selected === name) setSelected(next.steps[0]?.name ?? null);
			return next;
		});

	const doSave = () => {
		const badName = [flow.name, ...flow.steps.map((s) => s.name)].find((name) => !NAME_OK.test(name));
		if (badName) {
			setProblem(`"${badName}" is not a valid name — lower-case words joined by dashes.`);
			return;
		}
		if (flow.steps.length === 0) {
			setProblem("A flow needs at least one step.");
			return;
		}
		save.mutate(flow);
	};

	const applyJson = () => {
		try {
			const parsed = JSON.parse(jsonDraft ?? "") as FlowInfo;
			if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) throw new Error("a flow needs at least one step");
			setFlow({ ...flow, ...parsed });
			setProblem(null);
			setShowJson(false);
			setJsonDraft(null);
		} catch (error) {
			toast(`That JSON does not parse as a flow: ${error instanceof Error ? error.message : error}`);
		}
	};

	return (
		<section className="flow-editor">
			<header className="flow-meta">
				<button type="button" className="iconbtn" onClick={onClose} title="Back to the flows" aria-label="Back to the flows">
					<Icon name="back" className="icon icon-lg" />
				</button>
				<input className={`${field} flow-meta-title`} value={flow.title} onChange={(event) => update({ title: event.target.value })} disabled={readOnly} aria-label="Flow title" placeholder="Title" />
				<input className={`${monoField} flow-meta-name`} value={flow.name} onChange={(event) => update({ name: event.target.value })} disabled={readOnly} aria-label="Flow name" placeholder="flow-name" spellCheck={false} />
				{flow.source === "custom" && <span className="chip">yours</span>}
				<label className="flow-when" title="When the flow runs">
					{TRIGGERS.map((trigger) => (
						<label key={trigger} className="chip toggle">
							<input type="checkbox" checked={flow.when.includes(trigger)} disabled={readOnly} onChange={(event) => update({ when: event.target.checked ? [...flow.when, trigger] : flow.when.filter((t) => t !== trigger) })} />
							{trigger}
						</label>
					))}
				</label>
				<div className="grow" />
				{readOnly ? (
					<button
						type="button"
						className="btn primary"
						onClick={() => {
							setFlow({ ...flow, name: `${flow.name}-mine`, title: `${flow.title} (mine)`, source: "custom", layout: undefined });
							setProblem(null);
						}}
					>
						Duplicate to customize
					</button>
				) : (
					<>
						<button type="button" className="btn" onClick={() => setShowJson((open) => !open)} aria-pressed={showJson}>
							JSON
						</button>
						<button type="button" className="btn" onClick={() => update({ layout: undefined })} title="Recompute the automatic layout">
							Tidy
						</button>
						<button type="button" className="btn primary" onClick={doSave} disabled={save.isPending}>
							{save.isPending ? "Saving…" : "Save"}
						</button>
					</>
				)}
			</header>
			<p className="flow-meta-desc">
				<input className={field} value={flow.description} onChange={(event) => update({ description: event.target.value })} disabled={readOnly} aria-label="Flow description" placeholder="One sentence: what does this process guard?" />
			</p>
			{problem && <ErrorNote error={{ message: problem }} onRetry={() => setProblem(null)} />}
			{showJson ? (
				<div className="flow-json">
					<textarea className={`${monoField} grow`} value={jsonDraft ?? JSON.stringify(flow, null, 2)} onChange={(event) => setJsonDraft(event.target.value)} spellCheck={false} aria-label="Flow JSON" />
					<div className="flex gap-2">
						<button type="button" className="btn primary" onClick={applyJson}>
							Apply
						</button>
						<button type="button" className="btn" onClick={() => (setJsonDraft(null), setShowJson(false))}>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div className="flow-workbench">
					<aside className="flow-nodes">
						<header>Nodes</header>
						<ul>
							{flow.steps.map((node) => (
								<li key={node.name}>
									<button type="button" className={`flow-node-row${selected === node.name ? " on" : ""}${(flow.start ?? flow.steps[0]?.name) === node.name ? " start" : ""}`} onClick={() => setSelected(node.name)}>
										<span className={`glyph ${stepKind(node)}`}>{stepKind(node) === "command" ? ">_" : "✦"}</span>
										<span className="name">{node.name}</span>
									</button>
								</li>
							))}
						</ul>
						{!readOnly && (
							<button
								type="button"
								className="btn sm"
								onClick={() => {
									const name = freeStepName(flow);
									setFlow((current) => ({ ...current, steps: [...current.steps, { name, run: "true" }] }));
									setSelected(name);
								}}
							>
								<Icon name="plus" /> Add node
							</button>
						)}
						{broken.length > 0 && <p className="flow-hint">Never reached from the start: {broken.join(", ")}</p>}
					</aside>
					<div className="flow-board">
						<FlowGraph
							flow={flow}
							selected={selected}
							onSelect={setSelected}
							onMove={(name, x, y) => update({ layout: { ...flow.layout, [name]: { x, y } } })}
							onConnect={(from, to, verdict) => {
								const source = flow.steps.find((s) => s.name === from);
								if (source) updateStep(from, { on: { ...source.on, [verdict]: to } });
							}}
						/>
					</div>
					<aside className="flow-insp">
						{!step ? (
							<p className="text-slate">Select a node to edit it.</p>
						) : (
							<>
								<header className="flow-insp-head">
									<span className={`glyph ${stepKind(step)}`}>{stepKind(step) === "command" ? ">_" : "✦"}</span>
									<strong>{step.name}</strong>
									<span className="grow" />
									{!readOnly && (
										<>
											{start !== step.name && (
												<button type="button" className="btn sm" onClick={() => update({ start: step.name })} title="The walk begins here">
													Start here
												</button>
											)}
											<Confirmish onConfirm={() => removeStepAt(step.name)} />
										</>
									)}
								</header>
								{!readOnly && (
									<label className="flow-field">
										<span>Name</span>
										<input className={monoField} value={step.name} spellCheck={false} onChange={(event) => {
											const renamed = renameStep(flow, step.name, event.target.value.trim());
											setFlow(renamed);
											setSelected(event.target.value.trim());
										}} />
									</label>
								)}
								{!readOnly && (
									<fieldset className="flow-kinds">
										{(["command", "text", "prompt", "skill", "agent"] as const).map((kind) => (
											<label key={kind} className="chip toggle">
												<input type="radio" name="node-kind" checked={stepKind(step) === kind} onChange={() => updateStep(step.name, withKind(step, kind))} />
												{KIND_LABEL[kind]}
											</label>
										))}
									</fieldset>
								)}
								{stepKind(step) === "command" && (
									<>
										<label className="flow-field">
											<span>Command (exit 0 = pass)</span>
											<input className={monoField} value={step.run ?? ""} spellCheck={false} disabled={readOnly} onChange={(event) => updateStep(step.name, { run: event.target.value })} placeholder="npm test" />
										</label>
										<div className="flow-pair">
											<label className="flow-field">
												<span>Expect</span>
												<select className={field} value={step.expect ?? "pass"} disabled={readOnly} onChange={(event) => updateStep(step.name, { expect: event.target.value as "pass" | "note" })}>
													<option value="pass">pass — non-zero fails</option>
													<option value="note">note — never fails</option>
												</select>
											</label>
											<label className="flow-field">
												<span>Timeout (s)</span>
												<input className={field} type="number" min={1} value={step.timeoutSec ?? ""} disabled={readOnly} onChange={(event) => updateStep(step.name, event.target.value ? { timeoutSec: Number(event.target.value) } : { timeoutSec: undefined })} placeholder="600" />
											</label>
										</div>
									</>
								)}
								{stepKind(step) === "text" && (
									<label className="flow-field">
										<span>Instructions for the agent</span>
										<textarea className={`${field} flow-text`} rows={5} value={step.text ?? ""} disabled={readOnly} onChange={(event) => updateStep(step.name, { text: event.target.value })} placeholder={"Check the retry logic in {{worktreePath}}: is backoff exponential?"} />
									</label>
								)}
								{stepKind(step) === "prompt" && (
									<label className="flow-field">
										<span>Prompt file</span>
										<input className={monoField} value={step.prompt ?? ""} spellCheck={false} disabled={readOnly} onChange={(event) => updateStep(step.name, { prompt: event.target.value })} placeholder="my-review.md — beside the flow, or Tower's" />
									</label>
								)}
								{stepKind(step) === "skill" && (
									<label className="flow-field">
										<span>Skill</span>
										<input className={monoField} value={step.skill ?? ""} spellCheck={false} disabled={readOnly} onChange={(event) => updateStep(step.name, { skill: event.target.value })} placeholder="research" />
									</label>
								)}
								{stepKind(step) === "agent" && (
									<label className="flow-field">
										<span>Agent role</span>
										<input className={monoField} value={step.agent ?? ""} spellCheck={false} disabled={readOnly} onChange={(event) => updateStep(step.name, { agent: event.target.value })} placeholder="a saved pi agent" />
									</label>
								)}
								{(stepKind(step) === "skill" || stepKind(step) === "agent") && (
									<label className="flow-field">
										<span>Task (extra text)</span>
										<input className={field} value={step.task ?? ""} disabled={readOnly} onChange={(event) => updateStep(step.name, event.target.value ? { task: event.target.value } : { task: undefined })} />
									</label>
								)}
								{stepKind(step) !== "command" && (
									<div className="flow-pair">
										<label className="flow-field">
											<span>Model</span>
											<input className={field} value={step.model ?? ""} disabled={readOnly} onChange={(event) => updateStep(step.name, event.target.value ? { model: event.target.value } : { model: undefined })} placeholder="planning" />
										</label>
										<label className="flow-field">
											<span>Thinking</span>
											<select className={field} value={step.thinking ?? "medium"} disabled={readOnly} onChange={(event) => updateStep(step.name, { thinking: event.target.value as (typeof THINKING)[number] })}>
												{THINKING.map((level) => (
													<option key={level} value={level}>
														{level}
													</option>
												))}
											</select>
										</label>
									</div>
								)}
								{stepKind(step) !== "command" && (
									<label className="flow-field">
										<span>Access</span>
										<select className={field} value={step.access ?? "read-only"} disabled={readOnly} onChange={(event) => updateStep(step.name, { access: event.target.value as (typeof ACCESSES)[number] })}>
											{ACCESSES.map((access) => (
												<option key={access} value={access}>
													{access}
												</option>
											))}
										</select>
									</label>
								)}
								<div className="flow-pair">
									{(["pass", "fail"] as const).map((verdict) => (
										<label key={verdict} className="flow-field">
											<span>On {verdict}</span>
											<select className={field} value={step.on?.[verdict] ?? ""} disabled={readOnly} onChange={(event) => {
												const target = event.target.value;
												const on = { ...step.on };
												if (target) on[verdict] = target;
												else delete on[verdict];
												updateStep(step.name, { on: Object.keys(on).length ? on : undefined });
											}}>
												<option value="">{nextTarget(flow, step, verdict) ? "next in order" : "end the flow"}</option>
												{flow.steps.filter((candidate) => candidate.name !== step.name).map((candidate) => (
													<option key={candidate.name} value={candidate.name}>
														→ {candidate.name}
													</option>
												))}
												<option value={step.name}>→ {step.name} (again)</option>
											</select>
										</label>
									))}
								</div>
								<label className="flow-field">
									<span>Run cap (repairs before the loop loses)</span>
									<input className={field} type="number" min={1} value={step.maxRuns ?? ""} disabled={readOnly} onChange={(event) => updateStep(step.name, event.target.value ? { maxRuns: Number(event.target.value) } : { maxRuns: undefined })} placeholder="3" />
								</label>
							</>
						)}
					</aside>
				</div>
			)}
		</section>
	);
}

/** The node's delete control: armed confirmation, like every destructive button in Tower. */
function Confirmish({ onConfirm }: { onConfirm: () => void }) {
	const [armed, setArmed] = useState(false);
	return (
		<button
			type="button"
			className={`btn sm danger${armed ? " armed" : ""}`}
			onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
			onBlur={() => setArmed(false)}
		>
			{armed ? "Really?" : "Delete"}
		</button>
	);
}
