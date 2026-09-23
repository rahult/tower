import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, type FeedbackKind } from "../api/client.ts";
import { field } from "../ui.ts";
import { Modal } from "./bits.tsx";
import { Icon } from "./icons.tsx";
import { toast } from "./toasts.tsx";

const KINDS: Array<{ id: FeedbackKind; label: string; example: string }> = [
	{ id: "bug", label: "Bug", example: "Something broke or behaves wrong" },
	{ id: "feature", label: "Idea", example: "A capability you wish Tower had" },
	{ id: "feedback", label: "Feedback", example: "What works, what confuses you" },
];

/**
 * Reports a bug, idea or impression from the board to Tower's GitHub issues. The issue lands as an
 * inert backlog card on the maintainers' board — nothing is built until a person approves it there.
 */
export function FeedbackModal({ onClose }: { onClose: () => void }) {
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const [kind, setKind] = useState<FeedbackKind>("bug");
	const [title, setTitle] = useState("");
	const [details, setDetails] = useState("");
	const [diagnostics, setDiagnostics] = useState(true);
	const [fallback, setFallback] = useState<string | null>(null);
	const file = useMutation({
		mutationFn: () => api.fileFeedback({ kind, title: title.trim(), details: details.trim(), includeDiagnostics: diagnostics }),
		onSuccess: (issue) => {
			onClose();
			toast(`Filed as #${issue.number} on ${issue.repo}. It becomes a backlog card once intake sees it — a few minutes.`);
		},
		onError: (error) => setFallback((error as Error & { fallback?: string }).fallback ?? null),
	});

	const ready = title.trim() !== "";
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (ready && !file.isPending) {
			setFallback(null);
			file.mutate();
		}
	};

	return (
		<Modal title="Send feedback" onClose={onClose}>
			<p className="meta">
				Files a public issue on {settings.data ? `github.com/${settings.data.feedbackRepo}` : "Tower's GitHub"}. Issues come back to the maintainers' board as
				backlog cards; nothing is built until a person approves the card.
			</p>
			<form onSubmit={submit} className="grid gap-4">
				<div className="field">
					<label>What is this about?</label>
					<div className="seg" role="group" aria-label="Kind of feedback">
						{KINDS.map((entry) => (
							<button key={entry.id} type="button" aria-pressed={kind === entry.id} onClick={() => setKind(entry.id)}>
								{entry.label}
							</button>
						))}
					</div>
					<span className="hint">{KINDS.find((entry) => entry.id === kind)?.example}</span>
				</div>
				<div className="field">
					<label htmlFor="feedback-title" className="req">
						In one line
					</label>
					<input
						id="feedback-title"
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						autoFocus
						placeholder="Retry loop drops the second attempt"
						className={field}
					/>
				</div>
				<div className="field">
					<label htmlFor="feedback-details">The story</label>
					<span className="hint">What you did, what you expected, what happened. Steps to reproduce for a bug.</span>
					<textarea id="feedback-details" value={details} onChange={(event) => setDetails(event.target.value)} rows={5} className={`${field} !min-h-0 resize-y`} />
				</div>
				<div className="field">
					<label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate">
						<input type="checkbox" className="size-4 accent-[var(--primary)]" checked={diagnostics} onChange={(event) => setDiagnostics(event.target.checked)} />
						Attach environment — Tower version, OS and Node. No paths, names or secrets.
					</label>
				</div>
				<div className="acts !justify-between">
					<button type="button" onClick={onClose} className="btn ghost">
						Cancel
					</button>
					<button type="submit" disabled={!ready || file.isPending} className="btn primary">
						{file.isPending ? "Filing…" : "File the issue"}
					</button>
				</div>
				{file.error && !fallback && <p className="!mt-0 text-[14px] text-danger">{file.error.message}</p>}
				{file.error && fallback && (
					<p className="!mt-0 grid gap-2 text-[14px] text-danger">
						Could not file it from here: {file.error.message}
						<a href={fallback} target="_blank" rel="noreferrer noopener" className="btn ghost w-fit" onClick={onClose}>
							<Icon name="ext" />
							Open the prefilled issue on GitHub instead
						</a>
					</p>
				)}
			</form>
		</Modal>
	);
}
