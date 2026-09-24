// A small simulation of the stream. It follows the real card lifecycle: plan, wait for approval, build,
// verify, review, wait for approval again, done. The demo answers its own questions; nothing leaves the page.
(() => {
	// Scroll reveals: only arm them when motion is welcome; the observer lands each
	// block as it enters the view, and direct children stagger by index.
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (!reducedMotion) {
		document.documentElement.classList.add("js-reveal");
		for (const group of document.querySelectorAll("[data-reveal-group]")) {
			[...group.children].forEach((child, i) => child.style.setProperty("--i", String(i)));
		}
		const revealables = document.querySelectorAll("[data-reveal], [data-reveal-group]");
		if ("IntersectionObserver" in window) {
			const observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) {
							entry.target.classList.add("in");
							observer.unobserve(entry.target);
						}
					}
				},
				{ rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
			);
			for (const el of revealables) observer.observe(el);
		} else {
			for (const el of revealables) el.classList.add("in");
		}
	}

	// Day toggle: dark (Linear) is the default; the choice persists across visits.
	const themeButton = document.getElementById("theme-toggle");
	const syncThemeButton = () => {
		const day = document.documentElement.dataset.theme === "day";
		themeButton.textContent = day ? "Night" : "Day";
		themeButton.setAttribute("aria-label", day ? "Switch to the night theme" : "Switch to the day theme");
	};
	if (themeButton) {
		themeButton.addEventListener("click", () => {
			const day = document.documentElement.dataset.theme === "day";
			if (day) delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = "day";
			try {
				localStorage.setItem("tower-site-theme", day ? "day" : "dark");
			} catch {
				// Storage refused; the choice lasts for this visit.
			}
			syncThemeButton();
		});
		syncThemeButton();
	}

	// Copy buttons: hand over the install command, confirm for a beat, then stand down.
	for (const button of document.querySelectorAll("button.copy[data-copy]")) {
		button.addEventListener("click", async () => {
			const source = document.getElementById(button.dataset.copy);
			if (!source) return;
			const text = source.textContent.trim();
			let copied = false;
			try {
				await navigator.clipboard.writeText(text);
				copied = true;
			} catch {
				// Clipboard refused; fall through to the execCommand path.
			}
			if (!copied) {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				try {
					copied = document.execCommand("copy");
				} catch {
					copied = false;
				}
				area.remove();
			}
			button.textContent = copied ? "Copied" : "Select & copy";
			button.classList.toggle("done", copied);
			setTimeout(() => {
				button.textContent = "Copy";
				button.classList.remove("done");
			}, 1600);
		});
	}

	const needs = document.getElementById("needs");
	const flights = document.getElementById("flights");
	const dones = document.getElementById("dones");
	const pauseButton = document.getElementById("pause");
	const announcer = document.getElementById("announcer");
	const counts = {
		needs: document.getElementById("need-count"),
		flights: document.getElementById("flight-count"),
		dones: document.getElementById("done-count"),
	};
	if (!needs || !flights || !dones || !pauseButton) return;

	const PROJECTS = ["payments-api", "docs-site", "mobile-app"];
	const WORK = [
		{ title: "Idempotency keys for refunds" },
		{ title: "Rate-limit the webhook endpoint" },
		{ title: "Retry failed payouts with backoff" },
		{ title: "Add a search index for the guides" },
		{ title: "Offline queue for uploads" },
		{ title: "Deep links into a receipt" },
		{ title: "Paginate the ledger export" },
		{ title: "Fix broken anchors in the guides" },
	];
	const QUESTIONS = [
		"Which storage backend should this target?",
		"May this change the public CLI?",
	];
	const PLAN_MODEL = "fable-5-1";
	const BUILD_MODEL = "glm-5.3";
	const TICK_MS = 1000;

	let seq = 0;
	let paused = false;
	const elapsed = new Map();

	const make = (stage, state) => {
		seq += 1;
		return {
			id: `c${seq.toString(16)}`,
			project: PROJECTS[seq % PROJECTS.length],
			title: WORK[(seq - 1) % WORK.length].title,
			stage,
			state,
			model: stage === "planning" ? PLAN_MODEL : BUILD_MODEL,
		};
	};

	// The opening position shows every state at once, and is what stays on screen when motion is reduced.
	const cards = [
		make("planning", "gate"),
		make("building", "working"),
		make("testing", "passed"),
		make("backlog", "idle"),
	];

	const isWorking = (card) => card.state === "working" || card.state === "passed";
	const attention = () => cards.filter((card) => card.state === "gate" || card.state === "asked");
	const working = () => cards.filter(isWorking);
	const finished = () => cards.filter((card) => card.state === "done");

	// --- rendering: lists are rebuilt only when membership changes; timers update in place. ---

	const signatures = new Map();

	function rowHTML(card) {
		const ctx = `<p class="ctx"><span class="proj mono">${card.project}</span>`;
		if (card.state === "gate" || card.state === "asked") {
			const kind = card.state === "asked" ? "Waiting for your answer" : card.stage === "planning" ? "Plan approval" : "Review work";
			const why =
				card.state === "asked"
					? `${QUESTIONS[seq % QUESTIONS.length]}`
					: card.stage === "planning"
						? "The plan is ready. A cheap model will build from it alone."
						: "One review found something blocking; the checks pass.";
			const action = card.state === "asked" ? "Answer" : card.stage === "planning" ? "Approve &amp; build" : "Approve &amp; merge";
			return `${ctx}<span class="kind">${kind}</span></p><p class="title">${card.title}</p><p class="why">${why}</p><p class="acts"><button type="button" class="btn">${action}</button></p>`;
		}
		if (isWorking(card)) {
			const kind = card.state === "passed" ? "Your checks pass" : card.stage === "planning" ? "Planning" : "Building";
			return `${ctx}<span class="kind">${kind}</span><span class="mono">· ${card.model}</span></p><p class="title">${card.title}</p><p class="meter" aria-hidden="true"></p><p class="why"><span class="elapsed">…</span></p>`;
		}
		return `<p class="title">${card.title}</p><p class="why">merged locally</p>`;
	}

	function renderList(list, items, label) {
		const signature = items.map((card) => card.id + card.state).join("|");
		if (signatures.get(label) === signature) return;
		signatures.set(label, signature);
		list.innerHTML = "";
		for (const card of items) {
			const li = document.createElement("li");
			const attention = card.state === "gate" || card.state === "asked";
			li.className = `row ${attention ? "is-caution" : isWorking(card) ? "is-working" : "is-done"}`;
			li.innerHTML = rowHTML(card);
			const button = li.querySelector("button.btn");
			if (button) button.addEventListener("click", () => resolve(card));
			list.appendChild(li);
		}
	}

	function render() {
		renderList(needs, attention(), "needs");
		renderList(flights, working(), "flights");
		renderList(dones, finished().slice(-3), "dones");
		counts.needs.textContent = attention().length ? String(attention().length) : "";
		counts.flights.textContent = working().length ? String(working().length) : "";
		counts.dones.textContent = finished().length ? String(finished().length) : "";
		// Elapsed timers, matched to their row by title.
		for (const li of flights.children) {
			const card = working().find((candidate) => li.textContent.includes(candidate.title));
			const el = li.querySelector(".elapsed");
			if (card && el) el.textContent = `${elapsed.get(card.id) ?? 0}s in`;
		}
	}

	function say(text) {
		announcer.textContent = text;
	}

	// --- the lifecycle --------------------------------------------------------

	function resolve(card) {
		if (card.state === "asked") say(`${card.title}: answered`);
		else say(`${card.title}: approved`);
		if (card.stage === "planning") {
			card.stage = "building";
			card.state = "working";
			card.model = BUILD_MODEL;
			elapsed.set(card.id, 0);
		} else {
			card.stage = "done";
			card.state = "done";
			say(`${card.title}: landed`);
		}
		render();
	}

	function secondsFor(card) {
		if (card.stage === "planning") return 9;
		if (card.stage === "building") return 12;
		return 6;
	}

	function complete(card) {
		if (card.stage === "planning") {
			// Every other planning run stops to ask; the demo answers itself shortly after.
			if (seq % 2 === 0 && !card.asked) {
				card.state = "asked";
				card.asked = true;
				say(`${card.title}: asks a question`);
			} else if (card.asked) {
				resolve(card);
			} else {
				card.state = "gate";
				say(`${card.title}: plan ready for approval`);
			}
		} else if (card.stage === "building") {
			card.stage = "testing";
			card.state = "passed";
			elapsed.set(card.id, 0);
		} else {
			card.state = "gate";
			say(`${card.title}: reviewed, waiting for approval`);
		}
	}

	function tick() {
		if (paused) return;
		for (const card of cards.filter(isWorking)) {
			const seconds = (elapsed.get(card.id) ?? 0) + 1;
			elapsed.set(card.id, seconds);
			if (seconds >= secondsFor(card)) complete(card);
		}
		render();
	}

	// Self-driving: the demo presses its own buttons so a resting page still shows the loop.
	setInterval(() => {
		if (paused) return;
		const gate = cards.find((card) => card.state === "gate");
		if (gate) resolve(gate);
	}, 6500);
	setInterval(() => {
		if (paused) return;
		const asked = cards.find((card) => card.state === "asked");
		if (asked) resolve(asked);
	}, 4500);
	setInterval(() => {
		if (paused) return;
		if (working().length >= 2) return;
		const oldest = finished().at(0);
		if (!oldest) return;
		cards.splice(cards.indexOf(oldest), 1);
		const next = make("planning", "working");
		elapsed.set(next.id, 0);
		cards.unshift(next);
		render();
	}, 9000);

	pauseButton.addEventListener("click", () => {
		paused = !paused;
		pauseButton.setAttribute("aria-pressed", String(paused));
		pauseButton.textContent = paused ? "Resume" : "Pause";
	});

	render();
	const ticker = setInterval(tick, TICK_MS);
	// With motion reduced the page stays on the opening position instead of animating through the loop.
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) clearInterval(ticker);
})();
