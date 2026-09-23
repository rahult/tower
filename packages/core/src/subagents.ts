/**
 * Sub-agent crews: the pure half of Tower's parallel execution.
 *
 * A plan may declare two optional sections, and the daemon fans each entry out to its own session:
 *
 *   ## Scouts
 *   - **orm-choice**: Which ORM do the billing services actually use, and does it support partial indexes?
 *
 *   ## Streams
 *   - **cli**: Add the `closure` subcommand. Owns src/cli.ts and src/commands/closure.ts. Verify with `pnpm test --filter cli`.
 *
 * Scouts are read-only researchers that report before building starts; streams are built in parallel
 * worktrees by builder agents and merged by an integrator. Everything else about the format is lenient —
 * a section a parser cannot read is simply a plan without one, and the card builds single-session as before.
 */

export interface CrewEntry {
	/** Lower-case words joined by dashes; names the agent's session, worktree and report. */
	slug: string;
	/** The bullet's text plus any indented continuation lines under it. */
	text: string;
}

export interface CrewPlan {
	scouts: CrewEntry[];
	streams: CrewEntry[];
}

/** How many scouts and streams one card may spawn, so a runaway plan cannot spawn a runaway bill. */
export const MAX_CREW_MEMBERS = 4;

const SLUG = /[a-z0-9][a-z0-9-]*/;

const ITEM = /^[-*]\s+\*\*([\w-]+)\*\*\s*[:—–-]\s*(.*)$/;

/** Collects `- **slug**: text` bullets, with following indented lines folded into the text. */
function parseEntries(section: string): CrewEntry[] {
	const entries: CrewEntry[] = [];
	for (const line of section.split("\n")) {
		const item = line.match(ITEM);
		if (item) {
			const slug = (item[1] ?? "").toLowerCase().replaceAll("_", "-");
			if (SLUG.test(slug) && slug.length <= 40) entries.push({ slug, text: item[2]?.trim() ?? "" });
		} else if (entries.length > 0 && line.trim() !== "" && /^\s+\S/.test(line)) {
			// A continuation of the newest bullet: plans wrap long instructions onto the next lines.
			const last = entries[entries.length - 1];
			if (last) last.text = `${last.text}\n${line.trim()}`;
		}
	}
	return entries.slice(0, MAX_CREW_MEMBERS);
}

function sectionAfter(plan: string, heading: RegExp): string | null {
	const lines = plan.split("\n");
	const start = lines.findIndex((line) => heading.test(line.trim()));
	if (start === -1) return null;
	const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
	return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
}

/** Reads the crew sections out of a plan. Both absent, or present but empty, means "no crew". */
export function parseCrewPlan(plan: string): CrewPlan {
	const scoutsBlock = sectionAfter(plan, /^##\s+scouts\s*$/i);
	const streamsBlock = sectionAfter(plan, /^##\s+streams\s*$/i);
	return {
		scouts: scoutsBlock ? parseEntries(scoutsBlock) : [],
		streams: streamsBlock ? parseEntries(streamsBlock) : [],
	};
}

export const hasCrew = (crew: CrewPlan): boolean => crew.scouts.length > 0 || crew.streams.length > 0;

/** Where a scout leaves its report and a builder leaves its verdict: inside the card's folder. */
export const crewPaths = {
	scoutReport: (slug: string) => `research/scout-${slug}.md`,
	builderResult: (slug: string) => `crew/ws-${slug}-result.json`,
};
