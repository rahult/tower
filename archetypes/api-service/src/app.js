// The application: routes over a zero-dependency node:http server. Every route validates at the
// boundary — shape and size before the store ever sees a value — and answers with JSON. Handlers
// return replies; nothing in here touches the console.
import { createServer } from "node:http";

const json = (status, body) => ({ status, body });

/** Thrown by validators; becomes a 400 with its message before the store is touched. */
export class BoundaryError extends Error {}

export function requireObject(body) {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BoundaryError("The body must be a JSON object");
	return body;
}

export function trimmed(value, field, max) {
	if (typeof value !== "string" || value.trim() === "") throw new BoundaryError(`${field} must be a non-empty string`);
	const text = value.trim();
	if (text.length > max) throw new BoundaryError(`${field} is at most ${max} characters`);
	return text;
}

/** The worked example: items with a name, kept so the first real feature replaces it end to end. */
export function createApp(store) {
	const routes = [
		{ method: "GET", pattern: /^\/api\/health$/, handler: () => json(200, { ok: true }) },
		{
			method: "GET",
			pattern: /^\/api\/items$/,
			handler: () => json(200, store.list()),
		},
		{
			method: "POST",
			pattern: /^\/api\/items$/,
			handler: ({ body }) => {
				const fields = requireObject(body);
				const item = store.add(trimmed(fields.name, "name", 120));
				return json(201, item);
			},
		},
	];

	const respond = (response, reply) => {
		response.writeHead(reply.status, { "content-type": "application/json" });
		response.end(reply.body === null || reply.body === undefined ? "" : JSON.stringify(reply.body));
	};

	return createServer(async (incoming, response) => {
		const url = new URL(incoming.url ?? "/", "http://localhost");
		try {
			const route = routes.find((candidate) => candidate.method === incoming.method && candidate.pattern.test(url.pathname));
			if (!route) return respond(response, json(404, { error: "No such route" }));
			const params = url.pathname.match(route.pattern)?.slice(1) ?? [];
			const body = await readBody(incoming);
			respond(response, await route.handler({ params, query: url.searchParams, body }, params));
		} catch (error) {
			if (error instanceof BoundaryError) return respond(response, json(400, { error: error.message }));
			// A handler that throws is a bug, not a user error: 500, logged, never a hang.
			console.error(error);
			respond(response, json(500, { error: "Something went wrong" }));
		}
	});
}

async function readBody(incoming) {
	const chunks = [];
	for await (const chunk of incoming) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		throw new BoundaryError("The body must be JSON");
	}
}
