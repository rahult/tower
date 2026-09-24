import type { Annotation, StageRun } from "@tower/core";
import { useMutation, useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { type Artifact, api, type Gate } from "../api/client.ts";
import { Markdown } from "../content/Markdown.tsx";
import { Annotatable } from "./Annotations.tsx";
import { button, field } from "../ui.ts";

interface FeedbackPanelProps {
	cardId: string;
	gate: Gate;
	runs: StageRun[];
	artifacts: Artifact[];
	annotations: Annotation[];
	/** No origin remote, so approving merges the branch locally instead of opening a pull request. */
	mergesLocally?: boolean;
}

/** The last human decision before the finish line: what the checks said, what the reviewers found, then approve or send back. */
export function FeedbackPanel({ cardId, gate, runs, artifacts, annotations, mergesLocally }: FeedbackPanelProps) {
	const [feedback, setFeedback] = useState("");
	const reports = artifacts.filter((artifact) => artifact.name.startsWith("reviews/"));
	const contents = useQueries({ queries: reports.map((report) => ({ queryKey: ["artifact", cardId, report.name, report.modifiedAt], queryFn: () => api.artifact(cardId, report.name) })) });
	const decide = useMutation({ mutationFn: (decision: "approve" | "reject") => api.decideGate(cardId, gate.id, decision, feedback.trim()) });
	const openNotes = annotations.filter((annotation) => !annotation.resolved).length;

	const checks = runs.findLast((run) => run.kind === "verify" || (run.kind === "stage" && run.stage === "testing"));
	// The newest verdict of each review flow.
	const verdicts = new Map<string, StageRun>();
	for (const run of runs) if (run.kind === "flow_step") verdicts.set(run.id.replace(/^c[^-]+-/, "").replace(/-\d+$/, ""), run);
	const blocking = [...verdicts.values()].filter((run) => run.resultStatus === "fail").length;
	const askBuilder = () => setFeedback((current) => current || `Address the blocking findings in ${reports.map((report) => report.name).join(" and ")}.`);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<p className={`shrink-0 border-b border-rule px-4 py-2 text-[14px] ${blocking > 0 ? "bg-danger-soft" : "bg-caution-soft"}`}>
				{blocking > 0 ? `${blocking} review${blocking === 1 ? "" : "s"} found something blocking. ` : "The checks pass. "}
				Look at the Changes tab, then approve the work or send it back. Select text to pin a margin note.
			</p>
			<div className="min-h-0 flex-1 overflow-y-auto bg-sheet px-5 py-4">
				{checks && (
					<p className="mb-4 text-[14px]">
						<Verdict status={checks.resultStatus} /> <span className="font-semibold">Checks.</span> {checks.resultSummary}
					</p>
				)}
				{reports.length === 0 && <p className="text-[14px] text-slate">No review flows ran for this card. Choose which run under the project's Settings.</p>}
				{reports.map((report, index) => {
					const flow = report.name.replace(/^reviews\//, "").replace(/\.md$/, "");
					return (
						<details key={report.name} open={verdicts.get(flow)?.resultStatus === "fail" || reports.length === 1} className="mb-3 rounded-md border border-rule">
							<summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
								<Verdict status={verdicts.get(flow)?.resultStatus ?? null} />
								<span className="font-semibold">{flow.replaceAll("-", " ")}</span>
								<span className="min-w-0 flex-1 truncate text-[13px] text-slate">{verdicts.get(flow)?.resultSummary}</span>
							</summary>
							<div className="border-t border-rule px-4 py-3">
								<Annotatable cardId={cardId} artifact={report.name} annotations={annotations} contentKey={contents[index]?.data?.length}>
									{contents[index]?.data ? <Markdown text={contents[index].data as string} /> : <p className="text-slate">Loading…</p>}
								</Annotatable>
							</div>
						</details>
					);
				})}
			</div>
			<div className="shrink-0 border-t border-rule bg-sheet p-3">
				<label htmlFor="work-feedback" className="mb-1 block text-[13px] text-slate">
					To send it back, say what should change. A fresh builder gets your note and can read the review files.
					{reports.length > 0 && (
						<button type="button" onClick={askBuilder} className={`${button.link} ml-2`}>
							Ask it to fix the findings
						</button>
					)}
				</label>
				<textarea id="work-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={2} className={`${field} resize-y`} placeholder="Handle the empty list case the adversarial review found" />
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<button type="button" onClick={() => decide.mutate("approve")} disabled={decide.isPending} className={button.primary}>
						{mergesLocally ? "Approve and merge locally" : "Approve and open a pull request"}
					</button>
					<button type="button" onClick={() => decide.mutate("reject")} disabled={decide.isPending || (feedback.trim() === "" && openNotes === 0)} className={button.quiet}>
						Send back to the builder
					</button>
					{openNotes > 0 && (
						<span className="text-[13px] text-caution-text">
							{openNotes} open {openNotes === 1 ? "note" : "notes"} ride along with a rejection.
						</span>
					)}
					{decide.error && <span className="text-[14px] text-danger">{decide.error.message}</span>}
				</div>
			</div>
		</div>
	);
}

const VERDICT: Record<string, [string, string]> = { pass: ["bg-ok-soft text-ok", "Clear"], fail: ["bg-danger-soft text-danger", "Blocking"], blocked: ["bg-caution-soft text-ink", "Blocked"], missing: ["bg-caution-soft text-ink", "No verdict"] };

function Verdict({ status }: { status: string | null }) {
	const [tone, label] = VERDICT[status ?? ""] ?? ["bg-wash text-slate", "Pending"];
	return <span className={`rounded px-1.5 py-px text-[12px] font-semibold whitespace-nowrap ${tone}`}>{label}</span>;
}
