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
	it("locks a stage down by default: no extension discovery, no project trust", () => {
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
			"--no-approve",
		]);
	});

	it("adds allowlisted extensions, project trust and system prompt files when opted in", () => {
		const args = buildPiArgs({ ...base, extensions: ["/ext/a.ts", "npm:b"], trustProject: true, appendSystemPromptFiles: ["/p/role.md"] });
		expect(args.slice(-8)).toEqual(["--no-extensions", "-e", "/ext/a.ts", "-e", "npm:b", "--approve", "--append-system-prompt", "/p/role.md"]);
	});
});
