import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/index.ts";

const prompts = join(import.meta.dirname, "..", "..", "..", "prompts");

describe("renderPrompt", () => {
	it("substitutes variables and partials, including variables inside partials", () => {
		const out = renderPrompt("Hi {{name}}.\n{{> footer}}", { name: "Ada", path: "/x" }, { footer: "Write to {{path}}\n" });
		expect(out).toBe("Hi Ada.\nWrite to /x");
	});

	it("throws on an unknown variable rather than sending a prompt with a hole", () => {
		expect(() => renderPrompt("{{missing}}", {})).toThrow("Unknown prompt variable: missing");
	});

	it("throws on an unknown partial", () => {
		expect(() => renderPrompt("{{> nope}}", {})).toThrow("Unknown prompt partial: nope");
	});

	it("renders the shipped planning prompt with no holes", () => {
		const out = renderPrompt(
			readFileSync(join(prompts, "planning.md"), "utf8"),
			{
				worktreePath: "/wt",
				branchName: "tower/abc",
				title: "Add a thing",
				brief: "Do it well.",
				feedbackSection: "",
				planPath: "/card/plan.md",
				resultPath: "/card/stage-result.json",
			},
			{ "stage-result-contract": readFileSync(join(prompts, "partials", "stage-result-contract.md"), "utf8"), "invariant-protocol": "", "parallel-work": "", research: "", "system-model": "", acceptance: "", annotations: "" },
		);
		expect(out).not.toMatch(/\{\{/);
		expect(out).toContain("/card/plan.md");
		expect(out).toContain("/card/stage-result.json");
	});
});
