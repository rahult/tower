/**
 * Minimal template rendering for stage prompts.
 *   {{name}}      → vars[name]
 *   {{> partial}} → partials[partial], rendered with the same vars
 * Unknown names throw: a prompt with a hole in it must never reach a model.
 */
export function renderPrompt(template: string, vars: Record<string, string>, partials: Record<string, string> = {}): string {
	const withPartials = template.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_match, name: string) => {
		const partial = partials[name];
		if (partial === undefined) throw new Error(`Unknown prompt partial: ${name}`);
		return partial.trim();
	});
	return withPartials.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_match, name: string) => {
		const value = vars[name];
		if (value === undefined) throw new Error(`Unknown prompt variable: ${name}`);
		return value;
	});
}
