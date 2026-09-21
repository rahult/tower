import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Artifact, api } from "../api/client.ts";

export function ArtifactsPanel({ cardId, artifacts }: { cardId: string; artifacts: Artifact[] }) {
	const [open, setOpen] = useState<string | null>(null);
	const newest = artifacts.find((a) => a.name === open)?.modifiedAt;
	const content = useQuery({ queryKey: ["artifact", cardId, open, newest], queryFn: () => api.artifact(cardId, open as string), enabled: open !== null });

	if (artifacts.length === 0) return <p className="p-4 text-[14px] text-dust">This card has produced no files yet. The plan appears here when planning finishes.</p>;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ul className="flex flex-wrap gap-2 px-4 py-3">
				{artifacts.map((artifact) => (
					<li key={artifact.name}>
						<button
							type="button"
							onClick={() => setOpen(artifact.name === open ? null : artifact.name)}
							aria-pressed={artifact.name === open}
							className={`cursor-pointer rounded-[3px] px-2.5 py-1 font-mono text-[13px] ${artifact.name === open ? "bg-chalk text-ink" : "bg-well hover:bg-seam"}`}
						>
							{artifact.name}
						</button>
					</li>
				))}
			</ul>
			{open && (
				<pre className="mx-4 mb-4 flex-1 overflow-auto rounded-[3px] bg-buff p-4 font-sans text-[14px] leading-relaxed whitespace-pre-wrap text-ink">
					{content.isPending ? "Loading…" : content.error ? content.error.message : content.data}
				</pre>
			)}
		</div>
	);
}
