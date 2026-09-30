/**
 * Minimal OpenAI-compatible chat client, non-streaming.
 *
 * Bench model convention: a model string starting with `openrouter/` is remote — the prefix is
 * stripped here. Anything else is a local ollama model (see lib/ollama.ts). Pricing for the
 * models used here is verified $0 before the matrix starts (probe-openrouter script + the
 * /models pricing check recorded in the run's verdict).
 *
 * Endpoint override: BENCH_CHAT_BASE_URL / BENCH_CHAT_API_KEY redirect the client to any
 * OpenAI-compatible API (used to run matrices against a provider directly, e.g. DeepSeek
 * native with DEEPSEEK_API_KEY, instead of through OpenRouter).
 */
import type { ChatMessage, ChatResult, ToolSpec } from "./ollama.ts";

const BASE = process.env.BENCH_CHAT_BASE_URL ?? "https://openrouter.ai/api/v1";

export function isRemoteModel(model: string): boolean {
	return model.startsWith("openrouter/");
}

export function remoteModelId(model: string): string {
	return model.replace(/^openrouter\//, "");
}

interface Options {
	model: string;
	messages: ChatMessage[];
	tools?: ToolSpec[];
	temperature?: number;
	json?: boolean;
	timeoutMs?: number;
}

export async function chatRemote(options: Options, attempt = 0): Promise<ChatResult> {
	const key = process.env.BENCH_CHAT_API_KEY ?? process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("BENCH_CHAT_API_KEY / OPENROUTER_API_KEY is not set");
	let response: Response;
	try {
		response = await fetch(`${BASE}/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: remoteModelId(options.model),
				messages: options.messages.map((m) => ({
					role: m.role === "tool" ? "tool" : m.role,
					...(m.role === "tool" ? { tool_call_id: m.name ?? "call", name: m.name } : {}),
					content: m.content,
					...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
				})),
				...(options.tools?.length ? { tools: options.tools } : {}),
				temperature: options.temperature ?? 0.2,
				...(options.json ? { response_format: { type: "json_object" } } : {}),
			}),
			signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
		});
	} catch (error) {
		if (attempt < 6) {
			await new Promise((r) => setTimeout(r, Math.min(120_000, 15_000 * 2 ** attempt)));
			return chatRemote(options, attempt + 1);
		}
		throw error;
	}
	const text = await response.text();
	if ((response.status === 429 || response.status >= 500) && attempt < 6) {
		await new Promise((r) => setTimeout(r, Math.min(120_000, 15_000 * 2 ** attempt)));
		return chatRemote(options, attempt + 1);
	}
	if (!response.ok) throw new Error(`openrouter -> ${response.status}: ${text.slice(0, 400)}`);
	const data = JSON.parse(text);
	if (data.usage) {
		const cached = data.usage.prompt_tokens_details?.cached_tokens ?? 0;
		console.log(`remote call: ${data.usage.prompt_tokens ?? "?"} prompt (${cached} cached) + ${data.usage.completion_tokens ?? "?"} completion tokens, cost $${data.usage.cost ?? "?"}`);
	}
	const message = data.choices?.[0]?.message ?? {};
	return {
		content: typeof message.content === "string" ? message.content : "",
		toolCalls: Array.isArray(message.tool_calls)
			? message.tool_calls.map((c: any) => ({ function: { name: c.function?.name ?? "", arguments: JSON.parse(c.function?.arguments ?? "{}") } }))
			: [],
		usage: {
			promptTokens: data.usage?.prompt_tokens ?? 0,
			outputTokens: data.usage?.completion_tokens ?? 0,
		},
	};
}

/** True when the API key is present; used by the runner's preflight. */
export function hasRemoteCredentials(): boolean {
	return Boolean(process.env.OPENROUTER_API_KEY);
}
