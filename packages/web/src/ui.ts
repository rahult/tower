/** Shared control styles, so every button and field in the app reads as the same instrument. */
export const button = {
	primary: "cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[14px] font-semibold text-primary-ink hover:brightness-110 disabled:cursor-default disabled:opacity-45",
	quiet: "cursor-pointer rounded-md border border-rule bg-sheet px-3 py-1.5 text-[14px] font-semibold text-ink hover:bg-wash disabled:cursor-default disabled:opacity-45",
	danger: "cursor-pointer rounded-md border border-danger/40 bg-sheet px-3 py-1.5 text-[14px] font-semibold text-danger hover:bg-danger-soft disabled:cursor-default disabled:opacity-45",
	onCaution: "cursor-pointer rounded-md bg-caution-ink px-3 py-1.5 text-[14px] font-semibold text-caution hover:brightness-125 disabled:cursor-default disabled:opacity-45",
	link: "cursor-pointer text-[13px] font-semibold text-primary underline-offset-4 hover:underline",
};

export const field = "w-full rounded-md border border-rule bg-sheet px-3 py-1.5 text-ink placeholder:text-slate/70 focus:border-primary focus:outline-none";
export const monoField = `${field} font-mono text-[13px]`;
