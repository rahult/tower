import hljs from "highlight.js/lib/common";
import { memo, useMemo } from "react";

interface CodeBlockProps {
	code: string;
	/** A highlight.js language name. Unknown or missing languages render as plain text. */
	language?: string | null;
	className?: string;
}

// Highlighting a very large blob freezes the tab for no benefit; past this it is shown plain.
const MAX_HIGHLIGHT_CHARS = 200_000;

export const CodeBlock = memo(function CodeBlock({ code, language, className = "" }: CodeBlockProps) {
	const html = useMemo(() => {
		if (!language || !hljs.getLanguage(language) || code.length > MAX_HIGHLIGHT_CHARS) return null;
		// highlight.js escapes the source, so its output is safe to inject.
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	}, [code, language]);
	return (
		<pre className={`codeblock ${className}`}>
			{html === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
		</pre>
	);
});
