/** Minimal ollama native-API client: chat with optional tools, JSON mode, token accounting. */

const BASE = process.env.OLLAMA_HOST ?? "http://localhost:11434";

export interface ToolSpec {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
	function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_calls?: ToolCall[];
	/** For role "tool". */
	name?: string;
}

export interface ChatResult {
	content: string;
	toolCalls: ToolCall[];
	usage: { promptTokens: number; outputTokens: number };
}

async function post(path: string, body: unknown, timeoutMs: number): Promise<any> {
	const response = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`ollama ${path} -> ${response.status}: ${(await response.text()).slice(0, 500)}`);
	return response.json();
}

export interface ChatOptions {
	model: string;
	messages: ChatMessage[];
	tools?: ToolSpec[];
	numCtx?: number;
	numPredict?: number;
	temperature?: number;
	json?: boolean;
	timeoutMs?: number;
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
	const body: Record<string, unknown> = {
		model: options.model,
		messages: options.messages,
		stream: false,
		options: {
			num_ctx: options.numCtx ?? 16384,
			temperature: options.temperature ?? 0.2,
			...(options.numPredict ? { num_predict: options.numPredict } : {}),
		},
	};
	if (options.tools?.length) body.tools = options.tools;
	if (options.json) body.format = "json";
	const data = await post("/api/chat", body, options.timeoutMs ?? 600_000);
	const message = data.message ?? {};
	return {
		content: typeof message.content === "string" ? message.content : "",
		toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
		usage: {
			promptTokens: data.prompt_eval_count ?? 0,
			outputTokens: data.eval_count ?? 0,
		},
	};
}

/** Pulls the derived 16k-context tag for a model if missing. Blob is shared, so this is cheap. */
export async function ensure16kVariant(model: string): Promise<string> {
	const tag = `${model}-16k`;
	const list = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json());
	if ((list.models ?? []).some((m: any) => m.name === tag || m.name === `${tag}:latest`)) return tag;
	// Newer ollama create API: `from` + `parameters`. Blob layers are shared with the base model.
	const created = await post("/api/create", { model: tag, from: model, parameters: { num_ctx: 16384 }, stream: false }, 300_000);
	if (created.error) throw new Error(`ollama create ${tag}: ${created.error}`);
	return tag;
}
