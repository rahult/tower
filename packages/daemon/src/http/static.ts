import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Context } from "hono";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

/** Serves the built web UI with SPA fallback. In dev the dist is absent and Vite serves the UI instead. */
export function serveWeb(c: Context, webDist: string): Response {
	if (!existsSync(join(webDist, "index.html"))) {
		return c.text("Web UI is not built. Run `pnpm -C packages/web build`, or use `pnpm dev` and open the Vite URL.", 404);
	}
	const requested = normalize(join(webDist, c.req.path));
	const inside = requested.startsWith(webDist) && existsSync(requested) && statSync(requested).isFile();
	const file = inside ? requested : join(webDist, "index.html");
	return new Response(readFileSync(file), { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" } });
}
