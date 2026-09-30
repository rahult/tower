import { describe, expect, it } from "vitest";
import { buildPiArgs } from "../src/pi/argv.ts";

const base = {
	sessionId: "cabc-plan-1",
	cwd: "/wt",
	sessionDir: "/home/cards/abc/sessions",
	model: "anthropic/claude-fable-5-1",
	thinking: "high" as const,
	tools: ["read", "bash", "write"],
	extensions: [],
	trustProject: false,
	appendSystemPromptFiles: [],
};

describe("buildPiArgs", () => {
	it("locks a stage down by default: no environment discovery, no project trust", () => {
		expect(buildPiArgs(base)).toEqual([
			"--session-dir",
			"/home/cards/abc/sessions",
			"--session-id",
			"cabc-plan-1",
			"--model",
			"anthropic/claude-fable-5-1",
			"--thinking",
			"high",
			"--tools",
			"read,bash,write",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-approve",
		]);
	});

	it("adds allowlisted extensions, project trust and system prompt files when opted in", () => {
		const args = buildPiArgs({ ...base, extensions: ["/ext/a.ts", "npm:b"], trustProject: true, appendSystemPromptFiles: ["/p/role.md"] });
		expect(args.slice(-10)).toEqual(["--no-extensions", "--no-skills", "--no-prompt-templates", "-e", "/ext/a.ts", "-e", "npm:b", "--approve", "--append-system-prompt", "/p/role.md"]);
	});

	it("discovers the user's environment when the project opts in: none of the discovery locks", () => {
		const args = buildPiArgs({ ...base, piDiscovery: true, extensions: ["/ext/a.ts"] });
		expect(args).not.toContain("--no-extensions");
		expect(args).not.toContain("--no-skills");
		expect(args).not.toContain("--no-prompt-templates");
		// Explicit extension paths still ride along in discovery mode, as they do when locked down.
		expect(args).toEqual(["--session-dir", "/home/cards/abc/sessions", "--session-id", "cabc-plan-1", "--model", "anthropic/claude-fable-5-1", "--thinking", "high", "--tools", "read,bash,write", "-e", "/ext/a.ts", "--no-approve"]);
	});
});
