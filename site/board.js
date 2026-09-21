// A small simulation of the Tower board. It follows the real card lifecycle: plan, wait for approval, build,
// verify, and go back to a fresh builder when the checks fail. No network, no dependencies.
(() => {
	const STAGES = ["backlog", "planning", "building", "testing"];
	const STAGE_LABEL = { backlog: "Backlog", planning: "Planning", building: "Building", testing: "Testing" };
	const LANES = [
		{ id: "api", name: "payments-api", detail: "Verified by pnpm test" },
		{ id: "docs", name: "docs-site", detail: "Verified by pnpm build" },
		{ id: "app", name: "mobile-app", detail: "Verified by pnpm test" },
	];
	const TITLES = {
		api: ["Idempotency keys for refunds", "Rate-limit the webhook endpoint", "Paginate the ledger export", "Retry failed payouts with backoff"],
		docs: ["Add a search index", "Dark mode that follows the OS", "Versioned API reference", "Fix broken anchors in guides"],
		app: ["Offline queue for uploads", "Biometric unlock", "Reduce cold start time", "Deep links into a receipt"],
	};
	const TICK_MS = 1100;
	const DURATION = { planning: 5, building: 6, testing: 3, passed: 11, gate: 26, backlog: 4 };

	const board = document.getElementById("board");
	const pauseButton = document.getElementById("pause");
	const announcer = document.getElementById("announcer");
	if (!board || !pauseButton || !announcer) return;

	let nextId = 0x4a1f;
	const newId = () => (nextId += 0x1d3).toString(16).padStart(4, "0");
	const titleCursor = { api: 0, docs: 0, app: 0 };
	const nextTitle = (lane) => TITLES[lane][titleCursor[lane]++ % TITLES[lane].length];
	const card = (lane, stage, state, extra = {}) => ({ id: newId(), lane, title: nextTitle(lane), stage, state, left: DURATION[stage] ?? 0, attempt: 1, ...extra });

	// The opening position shows every state at once, and is what stays on screen when motion is reduced.
	let cards = [
		card("api", "planning", "gate", { left: DURATION.gate }),
		card("api", "backlog", "idle", { left: 9 }),
		card("docs", "building", "working", { failsOnce: true }),
		card("docs", "testing", "passed", { left: DURATION.passed }),
		card("app", "planning", "working"),
		card("app", "backlog", "idle", { left: 14 }),
	];

	// --- rendering: strips are keyed nodes that move between cells, so only what changed animates.
	const cells = new Map();
	const nodes = new Map();

	function buildGrid() {
		board.append(el("div"));
		for (const stage of STAGES) board.append(el("div", "col-head", STAGE_LABEL[stage]));
		for (const lane of LANES) {
			const head = el("div", "lane-head");
			head.append(el("strong", "", lane.name), el("span", "", lane.detail));
			board.append(head);
			STAGES.forEach((stage, index) => {
				const cell = el("div", index === STAGES.length - 1 ? "cell last" : "cell");
				cell.setAttribute("aria-label", `${lane.name}, ${STAGE_LABEL[stage]}`);
				cells.set(`${lane.id}:${stage}`, cell);
				board.append(cell);
			});
		}
	}

	function el(tag, className = "", text = "") {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text) node.textContent = text;
		return node;
	}

	function describe(c) {
		if (c.state === "gate") return { tint: "signal", status: "Waiting for approval", note: "" };
		if (c.state === "passed") return { tint: "sage", status: "Tests passed", note: c.attempt > 1 ? `Passed on build ${c.attempt}` : "" };
		if (c.state === "idle") return { tint: "", status: "Idle", note: "" };
		const status = c.stage === "testing" ? "Checking" : "Running";
		const note = c.stage === "building" && c.attempt > 1 ? "1 test failed. A fresh builder has the output" : "";
		return { tint: "sky working", status, note };
	}

	function render() {
		for (const [id, node] of nodes) {
			if (!cards.some((c) => c.id === id)) {
				node.remove();
				nodes.delete(id);
			}
		}
		for (const c of cards) {
			const { tint, status, note } = describe(c);
			const signature = `${c.stage}|${c.state}|${c.attempt}`;
			let node = nodes.get(c.id);
			if (!node) {
				node = el("div");
				nodes.set(c.id, node);
			}
			if (node.dataset.signature !== signature) {
				node.dataset.signature = signature;
				node.className = `strip ${tint}`.trim();
				node.replaceChildren(el("span", "holder"));
				const body = el("div", "body");
				const meta = el("span", "meta");
				meta.append(el("b", "", status), el("i", "", c.id));
				body.append(el("span", "title", c.title), meta);
				if (note) body.append(el("span", "note", note));
				if (c.state === "gate") {
					const act = el("div", "act");
					const approve = el("button", "", "Approve plan");
					approve.type = "button";
					approve.addEventListener("click", () => approvePlan(c.id, true));
					act.append(approve);
					body.append(act);
				}
				node.append(body);
			}
			const cell = cells.get(`${c.lane}:${c.stage}`);
			if (node.parentElement !== cell) cell.append(node);
		}
	}

	// --- lifecycle
	const laneBusy = (lane) => cards.some((c) => c.lane === lane && c.state === "working");

	function approvePlan(id, byVisitor) {
		const c = cards.find((x) => x.id === id);
		if (!c || c.state !== "gate") return;
		Object.assign(c, { stage: "building", state: "working", left: DURATION.building });
		if (byVisitor) announcer.textContent = `Plan approved. A cheap model is now building "${c.title}".`;
		render();
	}

	function tick() {
		for (const c of [...cards]) {
			c.left -= 1;
			if (c.left > 0) continue;
			if (c.state === "idle") {
				// One running card per project, like Tower's default per-project cap.
				if (laneBusy(c.lane)) c.left = 2;
				else Object.assign(c, { stage: "planning", state: "working", left: DURATION.planning });
			} else if (c.state === "gate") approvePlan(c.id, false);
			else if (c.state === "passed") {
				cards = cards.filter((x) => x !== c);
				cards.push(card(c.lane, "backlog", "idle", { left: DURATION.backlog, failsOnce: Math.random() < 0.4 }));
			} else if (c.stage === "planning") {
				Object.assign(c, { state: "gate", left: DURATION.gate });
				announcer.textContent = `"${c.title}" has a plan and is waiting for your approval.`;
			} else if (c.stage === "building") Object.assign(c, { stage: "testing", left: DURATION.testing });
			else if (c.failsOnce && c.attempt === 1) Object.assign(c, { stage: "building", attempt: 2, left: DURATION.building });
			else Object.assign(c, { state: "passed", left: DURATION.passed });
		}
		render();
	}

	// --- controls: auto-updating content gets a pause control, and starts paused when motion is reduced.
	let timer = null;
	function setPlaying(playing) {
		if (timer) clearInterval(timer);
		timer = playing ? setInterval(tick, TICK_MS) : null;
		pauseButton.textContent = playing ? "Pause" : "Play";
		pauseButton.setAttribute("aria-pressed", String(!playing));
	}
	pauseButton.addEventListener("click", () => setPlaying(timer === null));
	// Do not run in a background tab; pick up again only if we were the ones who stopped it.
	let pausedByTab = false;
	document.addEventListener("visibilitychange", () => {
		if (document.hidden && timer) {
			pausedByTab = true;
			setPlaying(false);
		} else if (!document.hidden && pausedByTab) {
			pausedByTab = false;
			setPlaying(true);
		}
	});

	for (const button of document.querySelectorAll("[data-copy]")) {
		button.addEventListener("click", async () => {
			const text = document.getElementById(button.dataset.copy)?.textContent ?? "";
			try {
				await navigator.clipboard.writeText(text);
				button.textContent = "Copied";
			} catch {
				button.textContent = "Select and copy";
			}
			setTimeout(() => (button.textContent = "Copy"), 1600);
		});
	}

	buildGrid();
	render();
	setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
})();
