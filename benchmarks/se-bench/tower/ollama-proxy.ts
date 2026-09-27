/**
 * OpenAI-compatible proxy in front of ollama for the Tower arm.
 *
 * pi (and therefore Tower) needs reliable structured tool calls over the /v1 protocol. ollama's
 * /v1 endpoint parses tool calls only when the model's raw output matches its template parser
 * exactly — with pi's long system prompt and tool set, llama3.1 and qwen2.5-coder both emit
 * tool calls as text, pi sees no tools, and every stage settles without its artifacts.
 *
 * This proxy: accepts /v1/chat/completions (streaming or not), calls ollama's native
 * /api/chat (stream: false), converts text-form tool calls into structured ones, and answers
 * with a normal OpenAI completion (streamed as a single chunk when asked).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const OLLAMA = process.env.OLLAMA_HOST ?? "http://localhost:11434";

interface OpenAITool {
	type: "function";
	function: { name: string; description?: string; parameters: unknown };
}
interface OpenAIMessage {
	role: string;
	content: string | null;
	tool_calls?: Array<{ id?: string; type: string; function: { name: string; arguments: string } }>;
	name?: string;
	tool_call_id?: string;
}

let callCounter = 0;

/** Recovers tool calls from assistant text: {"name": ...} objects with arguments or parameters. */
export function textToolCalls(content: string): Array<{ name: string; arguments: Record<string, unknown> }> {
	const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	const stripped = content.replace(/<tool_call>/g, "").replace(/<\/tool_call>/g, "");
	for (let i = stripped.indexOf("{"); i !== -1; i = stripped.indexOf("{", i + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let j = i; j < stripped.length; j++) {
			const ch = stripped[j];
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = !inString;
			else if (!inString && ch === "{") depth++;
			else if (!inString && ch === "}") {
				depth--;
				if (depth === 0) {
					try {
						const parsed = JSON.parse(stripped.slice(i, j + 1));
						const items = Array.isArray(parsed) ? parsed : [parsed];
						for (const item of items) if (item && typeof item.name === "string") calls.push({ name: item.name, arguments: item.arguments ?? item.parameters ?? {} });
					} catch {
						// not JSON, keep scanning
					}
					i = j;
					break;
				}
			}
		}
	}
	return calls;
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text;
				return "";
			})
			.join("");
	}
	return "";
}

function toOllamaMessages(messages: OpenAIMessage[]): unknown[] {
	return messages.map((message) => {
		if (message.role === "assistant" && message.tool_calls?.length) {
			return {
				role: "assistant",
				content: flattenContent(message.content),
				tool_calls: message.tool_calls.map((call) => ({
					function: { name: call.function.name, arguments: safeParse(call.function.arguments) },
				})),
			};
		}
		if (message.role === "tool") return { role: "tool", content: flattenContent(message.content), ...(message.name ? { name: message.name } : {}) };
		return { role: message.role, content: flattenContent(message.content) };
	});
}

function safeParse(text: string): Record<string, unknown> {
	try {
		return JSON.parse(text || "{}") as Record<string, unknown>;
	} catch {
		return { _raw: text };
	}
}

async function callOllama(body: Record<string, unknown>): Promise<{ content: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> }> {
	const response = await fetch(`${OLLAMA}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20 * 60_000),
	});
	if (!response.ok) throw new Error(`ollama /api/chat ${response.status}: ${(await response.text()).slice(0, 300)}`);
	const data = (await response.json()) as { message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> } };
	const message = data.message ?? {};
	let calls = (message.tool_calls ?? []).map((call) => ({ name: call.function.name, arguments: call.function.arguments ?? {} }));
	let content = typeof message.content === "string" ? message.content : "";
	if (calls.length === 0) calls = textToolCalls(content);
	if (calls.length > 0) content = "";
	return { content, toolCalls: calls };
}

function openAIResponse(id: string, model: string, result: { content: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> }): Record<string, unknown> {
	const message: Record<string, unknown> = { role: "assistant", content: result.content };
	if (result.toolCalls.length > 0) {
		message.tool_calls = result.toolCalls.map((call, index) => ({
			id: `call_${id}-${index}`,
			type: "function",
			function: { name: call.name, arguments: JSON.stringify(call.arguments) },
		}));
	}
	return {
		id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message, finish_reason: result.toolCalls.length > 0 ? "tool_calls" : "stop" }],
		usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
	};
}

function sendSSE(res: ServerResponse, id: string, model: string, result: { content: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> }): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	if (result.content) res.write(chunk({ role: "assistant", content: result.content }, null));
	for (const [index, call] of result.toolCalls.entries()) {
		res.write(
			chunk(
				{ tool_calls: [{ index, type: "function", id: `call_${id}-${index}`, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
				null,
			),
		);
	}
	res.write(chunk({}, result.toolCalls.length > 0 ? "tool_calls" : "stop"));
	res.write("data: [DONE]\n\n");
	res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => (data += chunk));
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

export interface ProxyHandle {
	port: number;
	stop: () => Promise<void>;
}

export function startProxy(models: string[], port = 4780): Promise<ProxyHandle> {
	const server = createServer(async (req, res) => {
		try {
			if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "ollama" })) }));
				return;
			}
			if (req.method !== "POST" || !(req.url ?? "").endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const body = JSON.parse(await readBody(req)) as { model: string; messages: OpenAIMessage[]; tools?: OpenAITool[]; temperature?: number; stream?: boolean };
			const payload: Record<string, unknown> = {
				model: body.model,
				messages: toOllamaMessages(body.messages ?? []),
				stream: false,
				options: { num_ctx: 16384, temperature: body.temperature ?? 0.2 },
			};
			if (body.tools?.length) {
				payload.tools = body.tools.map((tool) => ({ type: "function", function: { name: tool.function.name, description: tool.function.description ?? "", parameters: tool.function.parameters } }));
			}
			const id = `proxy-${++callCounter}`;
			const result = await callOllama(payload);
			if (body.stream) sendSSE(res, id, body.model, result);
			else {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(openAIResponse(id, body.model, result)));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message } }));
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () =>
			resolve({
				port,
				stop: () =>
					new Promise<void>((resolveStop) =>
						server.close(() => resolveStop()),
					),
			}),
		);
	});
}
