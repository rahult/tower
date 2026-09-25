import { assert, expectStatus } from "../helpers.mjs";

export const name = "creating an item appears in the list";

export async function run({ baseUrl, fetch }) {
	const created = await expectStatus(await fetch(`${baseUrl}/api/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "milk" }) }), 201, "create item");
	assert(created.body.name === "milk", "the created item does not echo its name");
	const list = await expectStatus(await fetch(`${baseUrl}/api/items`), 200, "list items");
	assert(list.body.some((item) => item.name === "milk"), "the created item is missing from the list");
}
