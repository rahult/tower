import type { Annotation } from "@tower/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client.ts";
import { ConfirmButton } from "../app/bits.tsx";
import { Icon } from "../app/icons.tsx";
import { button, field } from "../ui.ts";

/**
 * Margin notes: select text in the reader below, pin a note. The notes ride back to the agents —
 * with a gate rejection always, and in the stage prompts while they are unresolved — so the margin
 * is where a person's judgement enters the loop without leaving the text.
 */
export function Annotatable({ cardId, artifact, annotations, contentKey, children }: { cardId: string; artifact: string; annotations: Annotation[]; contentKey?: string | number; children: ReactNode }) {
	const queryClient = useQueryClient();
	const containerRef = useRef<HTMLDivElement>(null);
	const noteRef = useRef<HTMLTextAreaElement>(null);
	const [picked, setPicked] = useState<{ quote: string; x: number; y: number } | null>(null);
	const [note, setNote] = useState("");

	// After the reader selects text, offer the margin: a small composer anchored to the selection.
	const onMouseUp = useCallback(() => {
		const selection = window.getSelection();
		const container = containerRef.current;
		if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container) return setPicked(null);
		const quote = selection.toString().trim().replaceAll(/\s+/g, " ");
		const range = selection.getRangeAt(0);
		if (quote.length < 4 || !container.contains(range.commonAncestorContainer)) return setPicked(null);
		const rect = range.getBoundingClientRect();
		const host = container.getBoundingClientRect();
		setPicked({ quote, x: rect.left - host.left + rect.width / 2, y: rect.top - host.top });
		setNote("");
	}, []);

	const save = useMutation({
		mutationFn: () => api.addAnnotation(cardId, { artifact, quote: picked!.quote, note }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["card", cardId] });
			setPicked(null);
			window.getSelection()?.removeAllRanges();
		},
	});

	// Mark the quoted text where it appears in the rendered reader (best effort: quotes that span
	// elements are still listed below, just not highlighted inline).
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const marks = container.querySelectorAll("mark[data-annotation]");
		for (const mark of marks) {
			const parent = mark.parentNode;
			if (parent) {
				parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
				parent.normalize();
			}
		}
		for (const annotation of annotations.filter((a) => !a.resolved)) {
			const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const node = walker.currentNode as Text;
				const at = node.data.indexOf(annotation.quote);
				if (at === -1) continue;
				const range = document.createRange();
				range.setStart(node, at);
				range.setEnd(node, at + annotation.quote.length);
				const mark = document.createElement("mark");
				mark.dataset.annotation = annotation.id;
				mark.className = "margin-note";
				mark.title = annotation.note;
				try {
					range.surroundContents(mark);
				} catch {
					// The quote crosses element boundaries; the list below carries it instead.
				}
				break;
			}
		}
	}, [annotations, contentKey, children]);

	return (
		<div className="relative" ref={containerRef} onMouseUp={onMouseUp}>
			{children}
			{picked && (
				<div className="pop absolute z-20 w-80 rounded-md border border-rule bg-sheet p-2 shadow-lg" style={{ left: picked.x, top: picked.y, transform: "translate(-50%, calc(-100% - 0.5rem))" }} role="dialog" aria-label="Add a margin note">
					<p className="mb-1.5 truncate rounded bg-wash px-2 py-1 text-[12.5px] text-slate" title={picked.quote}>
						“{picked.quote}”
					</p>
					<textarea
						ref={noteRef}
						value={note}
						onChange={(event) => setNote(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") setPicked(null);
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save.mutate();
						}}
						rows={3}
						autoFocus
						className={`${field} resize-none`}
						placeholder="What should change here? (⌘⏎ to pin)"
					/>
					{save.error && <p className="mt-1 text-[13px] text-danger">{save.error.message}</p>}
					<div className="mt-2 flex items-center gap-2">
						<button type="button" className={`${button.primary} sm`} disabled={save.isPending || note.trim() === ""} onClick={() => save.mutate()}>
							<Icon name="plus" />
							{save.isPending ? "Pinning…" : "Pin note"}
						</button>
						<button type="button" className={`${button.quiet} sm`} onClick={() => setPicked(null)}>
							Cancel
						</button>
					</div>
				</div>
			)}
			<AnnotationList cardId={cardId} annotations={annotations.filter((a) => a.artifact === artifact)} />
		</div>
	);
}

/** The notes for one artifact, open ones first; resolving keeps the record and drops the agents' nag. */
export function AnnotationList({ cardId, annotations }: { cardId: string; annotations: Annotation[] }) {
	const queryClient = useQueryClient();
	const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["card", cardId] });
	const resolve = useMutation({ mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) => api.setAnnotation(cardId, id, resolved), onSuccess: invalidate });
	const remove = useMutation({ mutationFn: (id: string) => api.deleteAnnotation(cardId, id), onSuccess: invalidate });
	if (annotations.length === 0) return null;
	const open = annotations.filter((a) => !a.resolved);
	const done = annotations.filter((a) => a.resolved);
	return (
		<div className="mt-4 border-t border-rule pt-3">
			<p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate">
				Margin notes {open.length > 0 && <span className="ml-1 rounded bg-caution-soft px-1.5 py-px normal-case text-caution-text">{open.length} open</span>}
			</p>
			<ul className="grid gap-1.5">
				{[...open, ...done].map((annotation) => (
					<li key={annotation.id} className={`group rounded-md border px-2.5 py-1.5 text-[13.5px] ${annotation.resolved ? "border-rule bg-wash text-slate" : "border-caution/40 bg-caution-soft"}`}>
						<p className="truncate text-slate" title={annotation.quote}>
							“{annotation.quote}”
						</p>
						<p className={annotation.resolved ? "line-through" : ""}>{annotation.note}</p>
						<p className="mt-1 hidden items-center gap-1 group-hover:flex">
							<button type="button" className={`${button.link} !px-0 !text-[12.5px]`} disabled={resolve.isPending} onClick={() => resolve.mutate({ id: annotation.id, resolved: !annotation.resolved })}>
								{annotation.resolved ? "Reopen" : "Resolve"}
							</button>
							<ConfirmButton small label="Delete" confirmLabel="Delete note?" onConfirm={() => remove.mutate(annotation.id)} busy={remove.isPending} />
						</p>
					</li>
				))}
			</ul>
		</div>
	);
}
