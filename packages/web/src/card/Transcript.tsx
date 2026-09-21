import { useMutation } from "@tanstack/react-query";
import { memo, useEffect, useRef, useState } from "react";
import { api } from "../api/client.ts";
import { button, field } from "../ui.ts";
import { CodeBlock } from "../content/CodeBlock.tsx";
import { languageFor, prettyJson } from "../content/language.ts";
import { Markdown } from "../content/Markdown.tsx";
import { type Block, describeTool } from "./transcript-model.ts";

/** A session as it happened: what was asked of the agent, what it thought and said, and every tool it ran. */
export function Transcript({ blocks, live, runId }: { blocks: Block[]; live: boolean; runId: string }) {
	const end = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const scroller = useRef<HTMLDivElement>(null);

	// Follow the stream only while the reader is at the bottom; never yank them away from something they scrolled to.
	useEffect(() => {
		if (pinned.current) end.current?.scrollIntoView({ block: "end" });
	}, [blocks]);

	if (blocks.length === 0) {
		return <p className="min-h-0 flex-1 p-4 text-[14px] text-slate">{live ? "Waiting for the session to start talking." : "Nothing was recorded for this session."}</p>;
	}
	return (
		<div
			ref={scroller}
			onScroll={() => {
				const el = scroller.current;
				if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
			}}
			className="min-h-0 flex-1 overflow-y-auto bg-paper px-4 py-3"
		>
			<ol className="flex flex-col gap-3">
				{blocks.map((block) => (
					<li key={`${block.kind}-${block.seq}`}>
						<BlockView block={block} runId={runId} live={live} />
					</li>
				))}
			</ol>
			<div ref={end} />
		</div>
	);
}

// Blocks are immutable, so an unchanged block keeps its identity and skips re-rendering (Markdown parsing is not free).
const BlockView = memo(function BlockView({ block, runId, live }: { block: Block; runId: string; live: boolean }) {
	switch (block.kind) {
		case "prompt":
			return (
				<details className="rounded-md border border-rule bg-sheet">
					<summary className="cursor-pointer px-3 py-2 text-[14px] font-semibold">Instructions sent to the agent</summary>
					<div className="border-t border-rule px-3 py-3 text-[14px]">
						<Markdown text={block.text} />
					</div>
				</details>
			);
		case "steer":
			return (
				<div className="rounded-md border border-primary/30 bg-primary-soft px-3 py-2">
					<p className="text-[12px] font-semibold text-primary">You steered</p>
					<p className="whitespace-pre-wrap">{block.text}</p>
				</div>
			);
		case "assistant":
			return (
				<div className="flex flex-col gap-2">
					{block.thinking && <Reasoning text={block.thinking} streaming={block.streaming && !block.text} />}
					{block.text && <Markdown text={block.text} />}
				</div>
			);
		case "tool":
			return <ToolCall block={block} />;
		case "verify":
			return (
				<div className="overflow-hidden rounded-md border border-rule bg-sheet">
					<p className="border-b border-rule bg-wash px-3 py-1.5 font-mono text-[13px]">$ {block.command}</p>
					<pre className="max-h-[32rem] overflow-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">{block.output || "(no output yet)"}</pre>
				</div>
			);
		case "ui":
			return <ExtensionQuestion block={block} runId={runId} live={live} />;
		case "note":
			return block.tone === "error" ? (
				<p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[14px] text-danger">{block.text}</p>
			) : (
				<p className="text-[13px] text-slate">{block.text}</p>
			);
	}
});

/** A dialog a pi extension opened. The agent is stopped until it is answered, so it is amber and answerable right here. */
function ExtensionQuestion({ block, runId, live }: { block: Extract<Block, { kind: "ui" }>; runId: string; live: boolean }) {
	const [value, setValue] = useState("");
	const answer = useMutation({ mutationFn: (body: Record<string, unknown>) => api.answerUi(runId, block.id, body) });
	const { title, message, options, placeholder } = block.payload as { title?: string; message?: string; options?: string[]; placeholder?: string };
	const waiting = block.outcome === null && live;
	return (
		<div className={`rounded-md border px-3 py-2 ${waiting ? "border-caution bg-caution-soft" : "border-rule bg-sheet"}`}>
			<p className="text-[12px] font-semibold text-slate">{waiting ? "An extension is waiting for your answer" : block.outcome === "expired" ? "Nobody answered in time, so this was cancelled" : "An extension asked"}</p>
			<p className="font-semibold">{title ?? message}</p>
			{title && message && <p className="text-[14px]">{message}</p>}
			{waiting && (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{block.method === "confirm" && (
						<>
							<button type="button" className={button.primary} onClick={() => answer.mutate({ confirmed: true })}>Yes</button>
							<button type="button" className={button.quiet} onClick={() => answer.mutate({ confirmed: false })}>No</button>
						</>
					)}
					{block.method === "select" && (options ?? []).map((option) => <button key={option} type="button" className={button.quiet} onClick={() => answer.mutate({ value: option })}>{option}</button>)}
					{(block.method === "input" || block.method === "editor") && (
						<>
							<input value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} className={`${field} !w-auto min-w-0 flex-1`} />
							<button type="button" className={button.primary} disabled={!value.trim()} onClick={() => answer.mutate({ value })}>Send</button>
						</>
					)}
					<button type="button" className={button.link} onClick={() => answer.mutate({ cancelled: true })}>Dismiss</button>
					{answer.error && <span className="text-[13px] text-danger">{answer.error.message}</span>}
				</div>
			)}
		</div>
	);
}

/** Reasoning is long and rarely what you came for: open while it streams, folded away once the agent moves on. */
function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
	const words = text.trim().split(/\s+/).length;
	return (
		<details open={streaming} className="rounded-md border border-rule bg-sheet text-[13.5px] text-slate">
			<summary className="cursor-pointer px-3 py-1.5 font-semibold">
				{streaming ? "Reasoning" : "Reasoned"} <span className="font-normal">({words.toLocaleString()} words)</span>
			</summary>
			<p className="max-h-72 overflow-y-auto border-t border-rule px-3 py-2 leading-relaxed whitespace-pre-wrap">{text}</p>
		</details>
	);
}

function ToolCall({ block }: { block: Extract<Block, { kind: "tool" }> }) {
	const args = (block.args ?? {}) as Record<string, unknown>;
	const state = block.output === null ? "running" : block.isError ? "failed" : "done";
	const chip = state === "running" ? "bg-primary-soft text-primary" : state === "failed" ? "bg-danger-soft text-danger" : "bg-wash text-slate";
	// For a file being written, show the file itself, highlighted, rather than a JSON blob with an escaped string in it.
	const written = typeof args.path === "string" && typeof args.content === "string" ? { path: args.path, content: args.content } : null;
	const { content: _content, ...otherArgs } = args;
	const shownArgs = written ? otherArgs : args;
	const outputJson = block.output ? prettyJson(block.output) : null;

	return (
		<details className="overflow-hidden rounded-md border border-rule bg-sheet">
			<summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-[13px]">
				<span className="min-w-0 flex-1 truncate">{describeTool(block.name, block.args)}</span>
				<span className={`rounded px-1.5 py-px font-sans text-[12px] font-semibold ${chip}`}>{state}</span>
			</summary>
			<div className="flex flex-col gap-2 border-t border-rule bg-paper p-2">
				{Object.keys(shownArgs).length > 0 && <CodeBlock code={JSON.stringify(shownArgs, null, 2)} language="json" />}
				{written && <CodeBlock code={written.content} language={languageFor(written.path)} className="max-h-96" />}
				{block.output !== null &&
					(outputJson ? <CodeBlock code={outputJson} language="json" className="max-h-80" /> : <pre className="codeblock max-h-80 whitespace-pre-wrap">{block.output || "(no output)"}</pre>)}
			</div>
		</details>
	);
}
