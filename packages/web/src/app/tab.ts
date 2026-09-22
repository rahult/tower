/**
 * What a pinned tab says without being opened: the title carries the count of cards that need you,
 * and the favicon badges the same number, because tab titles truncate long before the number does.
 */
export function setTabUrgency(waiting: number): void {
	document.title = waiting > 0 ? `🔔 ${waiting} need${waiting === 1 ? "s" : ""} you — Tower` : "Tower";
	drawFavicon(waiting);
}

let source: HTMLCanvasElement | null = null;

function drawFavicon(waiting: number): void {
	if (!source) {
		source = document.createElement("canvas");
		source.width = 64;
		source.height = 64;
	}
	const ctx = source.getContext("2d");
	if (!ctx) return;
	ctx.clearRect(0, 0, source.width, source.height);
	// The board's dark bar, so the icon reads against light and dark tab strips alike.
	ctx.fillStyle = "#0f172a";
	ctx.beginPath();
	if (typeof ctx.roundRect === "function") ctx.roundRect(0, 0, source.width, source.height, 14);
	else ctx.rect(0, 0, source.width, source.height);
	ctx.fill();
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.font = "34px system-ui";
	ctx.fillText("🔔", 32, 34);
	if (waiting > 0) {
		ctx.fillStyle = "#f5b301"; // the board's caution amber
		ctx.beginPath();
		ctx.arc(49, 15, 14, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = "#2a1e00"; // caution ink, dark on amber
		ctx.font = `bold ${waiting < 10 ? 19 : 15}px system-ui`;
		ctx.fillText(waiting < 100 ? String(waiting) : "99", 49, 16);
	}
	let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		document.head.append(link);
	}
	link.href = source.toDataURL("image/png");
}
