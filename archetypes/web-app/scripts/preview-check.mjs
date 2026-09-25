#!/usr/bin/env node
// Preview check: exits 0 when this app's API and UI are really serving on their dev ports.
// Tower runs this after the preview starts, so a port that ended up answering with somebody
// else's app is reported as a degraded preview instead of silently trusted.

const apiPort = process.env.API_PORT ?? "8787";
const uiPort = process.env.UI_PORT ?? "5173";
const deadline = Date.now() + 45_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiHealthy(base, label) {
	try {
		const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
		if (response.status !== 200) return `${label} answered ${response.status}, expected 200 ok:true`;
		const body = await response.json();
		if (body?.ok !== true) return `${label} answered ${JSON.stringify(body).slice(0, 120)}, expected {"ok":true} — is another app holding the port?`;
		return null;
	} catch (error) {
		return `${label} not reachable yet (${error?.cause?.code ?? error?.name ?? "error"})`;
	}
}

// The UI port must serve a page AND proxy /api back to this app: a foreign dev server on the
// same port would pass a bare "is something there" probe, but not the proxied health check.
async function uiServing() {
	const pageProblem = await fetch(`http://localhost:${uiPort}/`, { signal: AbortSignal.timeout(2000) })
		.then(async (response) => {
			const text = await response.text();
			return response.status === 200 && text.includes("<script") ? null : `UI :${uiPort} answered ${response.status} without an app page`;
		})
		.catch((error) => `UI :${uiPort} not reachable yet (${error?.cause?.code ?? error?.name ?? "error"})`);
	if (pageProblem) return pageProblem;
	return apiHealthy(`http://localhost:${uiPort}`, `UI :${uiPort}'s /api proxy`);
}

let apiProblem = await apiHealthy(`http://localhost:${apiPort}`, `API :${apiPort}`);
let uiProblem = await uiServing();
while ((apiProblem ?? uiProblem) !== null && Date.now() < deadline) {
	await delay(1000);
	apiProblem ??= await apiHealthy(`http://localhost:${apiPort}`, `API :${apiPort}`);
	uiProblem ??= await uiServing();
}

if (apiProblem === null && uiProblem === null) {
	console.log(`preview check passed: API :${apiPort} and UI :${uiPort} (with its /api proxy) are serving this app`);
	process.exit(0);
}
if (apiProblem !== null) console.error(apiProblem);
if (uiProblem !== null) console.error(uiProblem);
process.exit(1);
