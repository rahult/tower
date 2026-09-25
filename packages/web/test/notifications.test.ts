import { describe, expect, it } from "vitest";
import type { Card } from "@tower/core";
import { duePings } from "../src/app/notifications.ts";

const card = (overrides: Partial<Card>): Card => ({
	id: "c1",
	projectId: "p1",
	title: "Card",
	brief: "",
	stage: "planning",
	status: "awaiting_input",
	priority: 0,
	position: 0,
	branchName: null,
	worktreePath: null,
	baseCommit: null,
	attempt: 0,
	stageConfig: {},
	prUrl: null,
	prState: null,
	finishNote: null,
	baseCardId: null,
	needsAttentionReason: null,
	issueUrl: null,
	issueNumber: null,
	issueAuthor: null,
	createdAt: 0,
	updatedAt: 0,
	...overrides,
});

describe("duePings", () => {
	it("pings each card that needs you once per hidden stretch, and only those", () => {
		const pinged = new Set<string>();
		const first = duePings([card({ id: "a" }), card({ id: "b", status: "running" }), card({ id: "c", status: "awaiting_gate" })], pinged);
		expect(first.map((c) => c.id)).toEqual(["a", "c"]);
		expect(duePings(first, pinged)).toEqual([]);
	});

	it("pings again when a handled card comes back needing you", () => {
		const pinged = new Set<string>();
		duePings([card({ id: "a" })], pinged);
		duePings([card({ id: "a", status: "running" })], pinged);
		const again = duePings([card({ id: "a", status: "needs_attention", needsAttentionReason: "The build failed." })], pinged);
		expect(again.map((c) => c.needsAttentionReason)).toEqual(["The build failed."]);
	});
});
