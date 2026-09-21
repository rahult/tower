import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

const REMARK = [remarkGfm];
// Unknown fence languages are common in agent output; show them plain instead of throwing.
const REHYPE: Parameters<typeof ReactMarkdown>[0]["rehypePlugins"] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

/** Renders Markdown written by an agent or a person. Raw HTML in the source is not rendered. */
export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
	return (
		<div className={`prose ${className}`}>
			<ReactMarkdown
				remarkPlugins={REMARK}
				rehypePlugins={REHYPE}
				components={{
					a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
