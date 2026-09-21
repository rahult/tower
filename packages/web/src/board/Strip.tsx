import type { Card } from "@tower/core";
import type { ReactNode } from "react";
import { describeCard, isLive, TINT_CLASS } from "./status.ts";

interface StripProps {
	card: Card;
	selected: boolean;
	onOpen: () => void;
	action: ReactNode;
}

/**
 * A card, drawn as a flight progress strip: boxed fields in a holder, tinted by state. It adapts to the width of
 * its container: in a board cell it stacks; given room (a wide lane) it lays its fields out in a row.
 */
export function Strip({ card, selected, onOpen, action }: StripProps) {
	const { status, tint } = describeCard(card);
	return (
		<li className={`flex items-stretch rounded-[3px] text-ink ${TINT_CLASS[tint]} ${selected ? "ring-2 ring-chalk ring-offset-2 ring-offset-rack" : ""}`}>
			<span aria-hidden className={`w-1.5 shrink-0 rounded-l-[3px] ${isLive(card) ? "sweep" : "bg-ink/25"}`} />
			<div className="flex min-w-0 flex-1 flex-col @2xl:flex-row @2xl:items-stretch">
				<button type="button" onClick={onOpen} className="min-w-0 flex-1 cursor-pointer px-2.5 py-2 text-left">
					<span className="line-clamp-2 leading-snug font-semibold">{card.title}</span>
					<span className="condensed mt-0.5 flex items-baseline gap-2 text-[13px]">
						<span className="font-semibold">{status}</span>
						<span className="ml-auto font-mono text-[11px] text-ink/60">{card.id}</span>
					</span>
					{card.needsAttentionReason && <span className="mt-0.5 line-clamp-2 text-[13px]">{card.needsAttentionReason}</span>}
				</button>
				{action && <span className="flex items-center border-t border-ink/25 px-2 py-1.5 @2xl:border-t-0 @2xl:border-l">{action}</span>}
			</div>
		</li>
	);
}

interface StripButtonProps {
	/** Omit for a form's submit button. */
	onClick?: () => void;
	disabled?: boolean;
	children: ReactNode;
}

export function StripButton({ onClick, disabled, children }: StripButtonProps) {
	return (
		<button
			type={onClick ? "button" : "submit"}
			onClick={onClick}
			disabled={disabled}
			className="condensed cursor-pointer rounded-[3px] border border-ink/60 px-2.5 py-1 text-[14px] font-semibold whitespace-nowrap hover:bg-ink hover:text-buff disabled:cursor-default disabled:opacity-40"
		>
			{children}
		</button>
	);
}
