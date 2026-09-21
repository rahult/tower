import { useEffect, useRef } from "react";
import { type Block, describeTool } from "./transcript-model.ts";

/**
 * What you and the daemon say to the agent sits on paper (buff), like a controller's annotations;
 * what the agent does sits on the rack.
 */
export function Transcript({ blocks, live }: { blocks: Block[]; live: boolean }) {
	const end = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const scroller = useRef<HTMLDivElement>(null);

	// Follow the stream only while the reader is at the bottom; never yank them away from something they scrolled to.
	useEffect(() => {
		if (pinned.current) end.current?.scrollIntoView({ block: "end" });
	}, [blocks]);

	if (blocks.length === 0) {
		return <p className="p-4 text-[14px] text-dust">{live ? "Waiting for the session to start talking." : "Nothing was recorded for this session."}</p>;
	}
	return (
		<div
			ref={scroller}
			onScroll={() => {
				const el = scroller.current;
				if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
			}}
			className="flex-1 overflow-y-auto px-4 py-3"
		>
			<ol className="flex max-w-[75ch] flex-col gap-3">
				{blocks.map((block) => (
					<li key={`${block.kind}-${block.seq}`}>
						<BlockView block={block} />
					</li>
				))}
			</ol>
			<div ref={end} />
		</div>
	);
}

function BlockView({ block }: { block: Block }) {
	switch (block.kind) {
		case "prompt":
			return (
				<details className="rounded-[3px] bg-buff px-3 py-2 text-ink">
					<summary className="cursor-pointer text-[14px] font-semibold">Instructions sent to the agent</summary>
					<pre className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap font-sans">{block.text}</pre>
				</details>
			);
		case "steer":
			return (
				<div className="rounded-[3px] bg-buff px-3 py-2 text-ink">
					<span className="text-[13px] font-semibold">You steered</span>
					<p className="whitespace-pre-wrap">{block.text}</p>
				</div>
			);
		case "assistant":
			return (
				<div>
					{block.thinking && <p className="mb-1 border-l-2 border-seam pl-3 text-[14px] whitespace-pre-wrap text-dust italic">{block.thinking}</p>}
					{block.text && <p className="whitespace-pre-wrap">{block.text}</p>}
				</div>
			);
		case "tool":
			return (
				<details className="rounded-[3px] bg-well font-mono text-[13px]">
					<summary className="flex cursor-pointer items-baseline gap-2 px-3 py-1.5">
						<span className="min-w-0 flex-1 truncate">{describeTool(block.name, block.args)}</span>
						<span className={block.isError ? "text-rose" : "text-dust"}>{block.output === null ? "running" : block.isError ? "failed" : "done"}</span>
					</summary>
					{block.output !== null && <pre className="max-h-72 overflow-auto border-t border-seam px-3 py-2 whitespace-pre-wrap text-dust">{block.output || "(no output)"}</pre>}
				</details>
			);
		case "verify":
			return (
				<div className="rounded-[3px] bg-well font-mono text-[13px]">
					<p className="border-b border-seam px-3 py-1.5">$ {block.command}</p>
					<pre className="max-h-[32rem] overflow-auto px-3 py-2 whitespace-pre-wrap text-dust">{block.output || "(no output yet)"}</pre>
				</div>
			);
		case "note":
			return <p className="text-[13px] text-dust">{block.text}</p>;
	}
}
