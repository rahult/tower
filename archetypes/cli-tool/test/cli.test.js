import { describe, expect, it } from "vitest";
import { dispatch } from "../src/cli.js";
import { greet } from "../src/commands/greet.js";

describe("greet", () => {
	it("greets by name", () => {
		expect(greet("ada")).toMatchObject({ message: "Hello, ada!", exitCode: 0 });
	});
	it("refuses an empty name with a usage line", () => {
		expect(greet("  ")).toMatchObject({ exitCode: 64, error: true });
	});
});

describe("dispatch", () => {
	it("help is the absence of a command", () => {
		expect(dispatch(undefined).exitCode).toBe(0);
	});
	it("unknown commands exit 64 with the name echoed", () => {
		expect(dispatch("frobnicate")).toMatchObject({ exitCode: 64, error: true });
	});
});
