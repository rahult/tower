import type { Annotation } from "@tower/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Artifact, api } from "../api/client.ts";
import { FileView } from "../content/FileView.tsx";
import { Annotatable } from "./Annotations.tsx";

/** The card's produced files, any of them annotatable: select text, pin a margin note. */
export function ArtifactsPanel({ cardId, artifacts, annotations }: { cardId: string; artifacts: Artifact[]; annotations: Annotation[] }) {
	const [picked, setPicked] = useState<string | null>(null);
	// Open the plan by default: it is what people come here for.
	const open = picked ?? artifacts.find((a) => a.name === "plan.md")?.name ?? artifacts[0]?.name ?? null;
	const modifiedAt = artifacts.find((a) => a.name === open)?.modifiedAt;
	const content = useQuery({ queryKey: ["artifact", cardId, open, modifiedAt], queryFn: () => api.artifact(cardId, open as string), enabled: open !== null });

	if (artifacts.length === 0) return <p className="p-4 text-[14px] text-slate">This card has produced no files yet. The plan appears here when planning finishes.</p>;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ul className="flex shrink-0 flex-wrap gap-1.5 border-b border-rule bg-sheet px-4 py-2">
				{artifacts.map((artifact) => (
					<li key={artifact.name}>
						<button
							type="button"
							onClick={() => setPicked(artifact.name)}
							aria-pressed={artifact.name === open}
							className={`cursor-pointer rounded px-2 py-1 font-mono text-[12.5px] ${artifact.name === open ? "bg-primary text-primary-ink" : "bg-wash text-ink hover:bg-rule"}`}
						>
							{artifact.name}
						</button>
					</li>
				))}
			</ul>
			<div className="min-h-0 flex-1 overflow-y-auto bg-sheet px-5 py-4">
				{content.isPending ? (
					<p className="text-slate">Loading…</p>
				) : content.error ? (
					<p className="text-danger">{content.error.message}</p>
				) : (
					open && (
						<Annotatable cardId={cardId} artifact={open} annotations={annotations} contentKey={content.data?.length}>
							<FileView name={open} text={content.data} />
						</Annotatable>
					)
				)}
			</div>
		</div>
	);
}
