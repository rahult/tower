#!/usr/bin/env node
// Preview check: exits 0 when this app's API and UI are really serving on their dev ports.
// Tower runs this after the preview starts, so a port that ended up answering with somebody
// else's app is reported as a degraded preview instead of silently trusted.

const apiPort = process.env.API_PORT ?? "8787";
const uiPort = process.env.UI_PORT ?? "5173";
const deadline = Date.now() + 45_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiHealthy() {
	try {
		const response = await fetch(`http://localhost:${apiPort}/api/health`, { signal: AbortSignal.timeout(2000) });
		if (response.status !== 200) return `API :${apiPort} answered ${response.status}, expected 200 ok:true`;
		const body = await response.json();
		if (body?.ok !== true) return `API :${apiPort} answered ${JSON.stringify(body).slice(0, 120)}, expected {"ok":true} — is another app holding the port?`;
		return null;
	} catch (error) {
		return `API :${apiPort} not reachable yet (${error?.cause?.code ?? error?.name ?? "error"})`;
	}
}

async function uiServing() {
	try {
		const response = await fetch(`http://localhost:${uiPort}/`, { signal: AbortSignal.timeout(2000) });
		const text = await response.text();
		if (response.status !== 200 || !text.includes("<script")) return `UI :${uiPort} answered ${response.status} without an app page — is another app holding the port?`;
		return null;
	} catch (error) {
		return `UI :${uiPort} not reachable yet (${error?.cause?.code ?? error?.name ?? "error"})`;
	}
}

let apiProblem = await apiHealthy();
let uiProblem = await uiServing();
while ((apiProblem ?? uiProblem) !== null && Date.now() < deadline) {
	await delay(1000);
	apiProblem ??= await apiHealthy();
	uiProblem ??= await uiServing();
}

if (apiProblem === null && uiProblem === null) {
	console.log(`preview check passed: API :${apiPort} is this app and UI :${uiPort} is serving`);
	process.exit(0);
}
if (apiProblem !== null) console.error(apiProblem);
if (uiProblem !== null) console.error(uiProblem);
process.exit(1);
