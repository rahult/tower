import { describe, expect, it } from "vitest";
import { resolveStageConfig, sessionIdFor, STAGE_SPECS } from "../src/index.ts";

describe("resolveStageConfig", () => {
	it("falls back to the stage default", () => {
		expect(resolveStageConfig("building", {})).toEqual(STAGE_SPECS.building.defaults);
	});

	it("applies card > project > global, field by field", () => {
		const config = resolveStageConfig("building", {
			global: { building: { model: "g/model", thinking: "low" } },
			project: { building: { model: "p/model" } },
			card: { building: { thinking: "high" } },
		});
		expect(config).toEqual({ model: "p/model", thinking: "high" });
	});

	it("ignores overrides for other stages", () => {
		expect(resolveStageConfig("planning", { card: { building: { model: "x/y" } } })).toEqual(STAGE_SPECS.planning.defaults);
	});
});

describe("sessionIdFor", () => {
	it("produces ids pi accepts", () => {
		const id = sessionIdFor("a1b2c3d4", "planning", 2);
		expect(id).toBe("ca1b2c3d4-plan-2");
		expect(id).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
	});
});
