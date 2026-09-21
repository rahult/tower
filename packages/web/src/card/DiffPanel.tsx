import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";

const LINE_CLASS: Array<[RegExp, string]> = [
	[/^(diff --git|index |--- |\+\+\+ )/, "text-dust"],
	[/^@@/, "text-sky"],
	[/^\+/, "bg-sage/15 text-sage"],
	[/^-/, "bg-rose/15 text-rose"],
];

export function DiffPanel({ cardId, refreshKey }: { cardId: string; refreshKey: number }) {
	const changes = useQuery({ queryKey: ["diff", cardId, refreshKey], queryFn: () => api.diff(cardId) });
	if (changes.isPending) return <p className="p-4 text-[14px] text-dust">Loading changes…</p>;
	if (changes.error) return <p className="p-4 text-[14px] text-rose">{changes.error.message}</p>;
	const { diff, untracked } = changes.data;
	if (!diff && untracked.length === 0) return <p className="p-4 text-[14px] text-dust">No changes on this card's branch yet. They appear here once building starts.</p>;
	return (
		<div className="flex-1 overflow-auto p-4">
			{untracked.length > 0 && (
				<p className="mb-3 text-[14px]">
					New files not yet committed: <span className="font-mono text-[13px]">{untracked.join(", ")}</span>
				</p>
			)}
			<pre className="font-mono text-[12.5px] leading-[1.55]">
				{diff.split("\n").map((line, index) => (
					// Diff lines have no identity beyond their position.
					<div key={index} className={LINE_CLASS.find(([pattern]) => pattern.test(line))?.[1] ?? ""}>
						{line || " "}
					</div>
				))}
			</pre>
		</div>
	);
}
