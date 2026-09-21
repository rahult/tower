import type { Card } from "@tower/core";
import type { ReactNode } from "react";
import { button } from "../ui.ts";
import { BAR_CLASS, CHIP_CLASS, describeCard, isLive } from "./status.ts";

interface StripProps {
	card: Card;
	selected: boolean;
	onOpen: () => void;
	action: ReactNode;
}

/**
 * A card, drawn as a flight progress strip: a white strip in a holder whose bar colour is its state.
 * The one exception is a card that needs you, which is filled solid amber so it cannot be missed.
 */
export function Strip({ card, selected, onOpen, action }: StripProps) {
	const { status, tone } = describeCard(card);
	const caution = tone === "caution";
	return (
		<li
			className={`flex overflow-hidden rounded-md border ${caution ? "border-caution bg-caution text-caution-ink" : "border-rule bg-sheet text-ink"} ${
				selected ? "ring-2 ring-primary ring-offset-1 ring-offset-wash" : ""
			}`}
		>
			<span aria-hidden className={`w-1.5 shrink-0 ${isLive(card) ? "sweep" : BAR_CLASS[tone]}`} />
			<div className="flex min-w-0 flex-1 flex-col @2xl:flex-row @2xl:items-stretch">
				<button type="button" onClick={onOpen} className="min-w-0 flex-1 cursor-pointer px-2.5 py-2 text-left">
					<span className="line-clamp-2 leading-snug font-semibold">{card.title}</span>
					<span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className={`rounded px-1.5 py-px text-[12px] font-semibold whitespace-nowrap ${CHIP_CLASS[tone]}`}>{status}</span>
						<span className={`ml-auto font-mono text-[11px] ${caution ? "text-caution-ink/70" : "text-slate"}`}>{card.id}</span>
					</span>
					{card.needsAttentionReason && <span className="mt-1.5 line-clamp-3 text-[13px] leading-snug">{card.needsAttentionReason}</span>}
				</button>
				{action && <span className={`flex items-center border-t px-2 py-1.5 @2xl:border-t-0 @2xl:border-l ${caution ? "border-caution-ink/20" : "border-rule"}`}>{action}</span>}
			</div>
		</li>
	);
}

interface StripButtonProps {
	/** Omit for a form's submit button. */
	onClick?: () => void;
	disabled?: boolean;
	kind?: keyof typeof button;
	children: ReactNode;
}

export function StripButton({ onClick, disabled, kind = "quiet", children }: StripButtonProps) {
	return (
		<button type={onClick ? "button" : "submit"} onClick={onClick} disabled={disabled} className={`${button[kind]} !px-2.5 !py-1 !text-[13px] whitespace-nowrap`}>
			{children}
		</button>
	);
}
