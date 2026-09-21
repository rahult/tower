import { describe, expect, it } from "vitest";
import { languageFor, prettyJson } from "../src/content/language.ts";

describe("languageFor", () => {
	it.each([
		["plan.md", "markdown"],
		["stage-result.json", "json"],
		["src/cli.ts", "typescript"],
		["/abs/path/App.tsx", "typescript"],
		["Dockerfile", "dockerfile"],
		["verify-output-1.txt", null],
		["LICENSE", null],
	])("%s -> %s", (name, language) => expect(languageFor(name)).toBe(language));
});

describe("prettyJson", () => {
	it("pretty-prints objects and arrays", () => {
		expect(prettyJson('{"status":"pass","n":[1,2]}')).toBe('{\n  "status": "pass",\n  "n": [\n    1,\n    2\n  ]\n}');
	});
	it("leaves everything else alone", () => {
		for (const text of ["hello", "12", '"quoted"', "{not json", ""]) expect(prettyJson(text)).toBeNull();
	});
});
