import { assert, expectStatus } from "../helpers.mjs";

export const name = "greet says hello";

export async function run({ cli }) {
	const out = expectStatus(await cli(["greet", "ada"]), 0, "greet ada");
	assert(out.stdout.includes("Hello, ada!"), `unexpected output: ${out.stdout}`);
}
