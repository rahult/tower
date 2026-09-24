import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Db } from "./db.ts";

interface Route {
	method: string;
	pattern: RegExp;
	handler: (request: Request, params: string[]) => Promise<Reply> | Reply;
}

export interface Reply {
	status: number;
	body: unknown;
}

/** The request, already parsed: the body is JSON or absent, and nothing else reaches a handler. */
export interface Request {
	params: string[];
	query: URLSearchParams;
	body: unknown;
}

const json = (status: number, body: unknown): Reply => ({ status, body });

/**
 * The application: routes over a zero-dependency node:http server. Every route validates at the
 * boundary — shape and size before the database ever sees a value — and answers with JSON.
 */
export function createApp(db: Db): Server {
	const routes: Route[] = [
		{ method: "GET", pattern: /^\/api\/health$/, handler: () => json(200, { ok: true }) },
		{ method: "GET", pattern: /^\/api\/notes$/, handler: () => json(200, db.listNotes()) },
		{
			method: "POST",
			pattern: /^\/api\/notes$/,
			handler: ({ body }) => {
				const note = body as { body?: unknown };
				if (typeof note?.body !== "string" || note.body.trim() === "") return json(400, { error: "A note needs a non-empty body" });
				if (note.body.length > 2000) return json(400, { error: "A note is at most 2000 characters" });
				const created = db.addNote(note.body.trim());
				return created ? json(201, created) : json(409, { error: "That note already exists" });
			},
		},
		{
			method: "DELETE",
			pattern: /^\/api\/notes\/(\d+)$/,
			handler: ({ params }) => (db.deleteNote(Number(params[0])) ? json(204, null) : json(404, { error: "No such note" })),
		},
	];

	const respond = (response: ServerResponse, reply: Reply): void => {
		response.writeHead(reply.status, { "content-type": "application/json" });
		response.end(reply.body === null || reply.body === undefined ? "" : JSON.stringify(reply.body));
	};

	return createServer(async (incoming: IncomingMessage, response: ServerResponse) => {
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

async function readBody(incoming: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of incoming) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		throw new BoundaryError("The body must be JSON");
	}
}

export class BoundaryError extends Error {}
