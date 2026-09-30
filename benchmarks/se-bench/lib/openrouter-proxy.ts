/**
 * Retry-and-forward proxy in front of OpenRouter, for the free model tier.
 *
 * Free endpoints throttle hard (429s, transient 5xx, finish_reason "error" mid-stream) and pi
 * in print mode treats any provider error as fatal. This proxy answers on localhost /v1, forwards
 * to OpenRouter, and retries 429/5xx/network failures and error-finished completions with capped
 * exponential backoff — so a flaky free tier degrades into slower cells instead of dead ones.
 * Streaming requests get the full completion as a single SSE chunk, like the ollama proxy does.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const UPSTREAM = process.env.BENCH_CHAT_BASE_URL ?? "https://openrouter.ai/api/v1";

const MAX_ATTEMPTS = 8;
const backoffMs = (attempt: number) => Math.min(120_000, 15_000 * 2 ** attempt);

export interface RetryProxyHandle {
	port: number;
	stop: () => Promise<void>;
}

export async function startOpenRouterProxy(requestedPort: number, log: (line: string) => void): Promise<RetryProxyHandle> {
	const key = process.env.BENCH_CHAT_API_KEY ?? process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("BENCH_CHAT_API_KEY / OPENROUTER_API_KEY is not set");

	const server = createServer((req, res) => {
		if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "proxy only forwards /v1/chat/completions" }));
			return;
		}
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => void forward(req, res, body));
	});

	async function forward(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
		const wantsStream = /"stream"\s*:\s*true/.test(body);
		// Ask upstream for one complete completion; if the client wanted SSE we re-wrap it ourselves.
		// Some providers (DeepSeek) reject stream_options without stream:true — strip both.
		let upstreamBody = body;
		if (wantsStream || /"stream_options"/.test(body)) {
			try {
				const parsed = JSON.parse(body);
				delete parsed.stream_options;
				if (wantsStream) parsed.stream = false;
				upstreamBody = JSON.stringify(parsed);
			} catch {
				upstreamBody = body.replace(/"stream"\s*:\s*true/g, '"stream":false').replace(/,\s*"stream_options"\s*:\s*\{[^}]*\}/, "");
			}
		}
		log(`request ${(Buffer.byteLength(body) / 1024).toFixed(0)}kB`);
		let lastError = "no attempts";
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			if (attempt > 0) {
				log(`openrouter-proxy retry ${attempt}/${MAX_ATTEMPTS} after ${lastError.slice(0, 120)}`);
				await new Promise((r) => setTimeout(r, backoffMs(attempt - 1)));
			}
			try {
				const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
					method: "POST",
					headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
					body: upstreamBody,
					signal: AbortSignal.timeout(600_000),
				});
				const text = await upstream.text();
				if (upstream.status === 429 || upstream.status >= 500) {
					lastError = `upstream ${upstream.status}: ${text.slice(0, 120)}`;
					continue;
				}
				if (!upstream.ok) {
					// 4xx other than throttle: request itself is bad, don't retry.
					res.writeHead(upstream.status, { "content-type": "application/json" });
					res.end(text);
					return;
				}
				log(`openrouter-proxy -> ${upstream.status} (${text.length}b)`);
				const json = JSON.parse(text);
				if (json.usage) {
					const cached = json.usage.prompt_tokens_details?.cached_tokens ?? 0;
					log(`usage: ${json.usage.prompt_tokens ?? "?"} prompt (${cached} cached) + ${json.usage.completion_tokens ?? "?"} completion, cost $${(json.usage.cost ?? 0).toFixed(4)}`);
				}
				if (json.choices?.[0]?.finish_reason === "error") {
					lastError = "finish_reason: error";
					continue;
				}
				if (wantsStream) {
					// Re-wrap the complete completion as proper chat.completion.chunk deltas.
					res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
					const message = json.choices?.[0]?.message ?? {};
					const delta: Record<string, unknown> = {};
					if (message.role) delta.role = message.role;
					if (message.content) delta.content = message.content;
					if (message.tool_calls?.length) {
						delta.tool_calls = message.tool_calls.map((c: any, index: number) => ({
							index,
							id: c.id,
							type: "function",
							function: { name: c.function?.name, arguments: c.function?.arguments },
						}));
					}
					const finish = json.choices?.[0]?.finish_reason ?? "stop";
					const chunk = (d: Record<string, unknown>, f: string | null): string =>
						`data: ${JSON.stringify({ id: json.id ?? "chatcmpl-proxy", object: "chat.completion.chunk", created: json.created ?? Math.floor(Date.now() / 1000), model: json.model ?? "", choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
					if (Object.keys(delta).length > 0) res.write(chunk(delta, null));
					res.write(chunk({}, finish));
					res.write("data: [DONE]\n\n");
					res.end();
				} else {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(text);
				}
				return;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
		log(`openrouter-proxy giving up after ${MAX_ATTEMPTS} attempts: ${lastError.slice(0, 160)}`);
		res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: `openrouter-proxy exhausted retries: ${lastError}` } }));
	}

	await new Promise<void>((resolve) => server.listen(requestedPort, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	log(`openrouter-proxy listening on 127.0.0.1:${port}`);
	return {
		port,
		stop: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
