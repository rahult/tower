import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";

const LINE_CLASS: Array<[RegExp, string]> = [
	[/^diff --git/, "mt-3 border-t border-rule bg-wash pt-1 font-semibold text-ink first:mt-0"],
	[/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename)/, "bg-wash text-slate"],
	[/^@@/, "bg-primary-soft text-primary"],
	[/^\+/, "bg-ok-soft text-ink"],
	[/^-/, "bg-danger-soft text-ink"],
];

export function DiffPanel({ cardId, refreshKey }: { cardId: string; refreshKey: number }) {
	const changes = useQuery({ queryKey: ["diff", cardId, refreshKey], queryFn: () => api.diff(cardId) });
	if (changes.isPending) return <p className="p-4 text-[14px] text-slate">Loading changes…</p>;
	if (changes.error) return <p className="p-4 text-[14px] text-danger">{changes.error.message}</p>;
	const { diff, untracked } = changes.data;
	if (!diff && untracked.length === 0) return <p className="p-4 text-[14px] text-slate">No changes on this card's branch yet. They appear here once building starts.</p>;
	return (
		<div className="min-h-0 flex-1 overflow-auto bg-sheet p-4">
			{untracked.length > 0 && (
				<p className="mb-3 text-[14px]">
					New files not yet committed: <span className="font-mono text-[13px]">{untracked.join(", ")}</span>
				</p>
			)}
			<pre className="w-max min-w-full font-mono text-[12.5px] leading-[1.55]">
				{diff.split("\n").map((line, index) => (
					// Diff lines have no identity beyond their position.
					<div key={index} className={`px-2 ${LINE_CLASS.find(([pattern]) => pattern.test(line))?.[1] ?? ""}`}>
						{line || " "}
					</div>
				))}
			</pre>
		</div>
	);
}
