import { CodeBlock } from "./CodeBlock.tsx";
import { languageFor, prettyJson } from "./language.ts";
import { Markdown } from "./Markdown.tsx";

/** Shows a file the way its type deserves: Markdown rendered, JSON pretty-printed, code highlighted. */
export function FileView({ name, text }: { name: string; text: string }) {
	const language = languageFor(name);
	if (language === "markdown") return <Markdown text={text} />;
	if (language === "json") return <CodeBlock code={prettyJson(text) ?? text} language="json" />;
	return <CodeBlock code={text} language={language} />;
}
