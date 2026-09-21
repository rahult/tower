/** highlight.js language for a file name, or null when it should be shown as plain text. */
const BY_EXTENSION: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonl: "json", md: "markdown", markdown: "markdown",
	py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php",
	sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
	yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini",
	html: "xml", xml: "xml", svg: "xml", vue: "xml",
	css: "css", scss: "scss", less: "less", sql: "sql", diff: "diff", patch: "diff",
	graphql: "graphql", lua: "lua", r: "r", pl: "perl", makefile: "makefile", dockerfile: "dockerfile",
};

export function languageFor(fileName: string): string | null {
	const base = fileName.split("/").pop()?.toLowerCase() ?? "";
	if (base === "dockerfile" || base === "makefile") return base;
	const extension = base.includes(".") ? base.split(".").pop() : "";
	return (extension && BY_EXTENSION[extension]) || null;
}

/** Pretty-prints text that is JSON; returns null for anything else, so callers fall back to plain text. */
export function prettyJson(text: string): string | null {
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed)) return null;
	try {
		return JSON.stringify(JSON.parse(trimmed), null, 2);
	} catch {
		return null;
	}
}
