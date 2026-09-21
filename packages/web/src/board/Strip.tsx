import type { Card } from "@traffic-control/core";
import type { ReactNode } from "react";
import { describeCard, isLive, TINT_CLASS } from "./status.ts";

interface StripProps {
	card: Card;
	selected: boolean;
	onOpen: () => void;
	action: ReactNode;
}

/** A card, drawn as a flight progress strip: boxed fields in a holder, tinted by state. */
export function Strip({ card, selected, onOpen, action }: StripProps) {
	const { stage, status, tint } = describeCard(card);
	return (
		<li className={`flex items-stretch rounded-[3px] text-ink ${TINT_CLASS[tint]} ${selected ? "ring-2 ring-chalk ring-offset-2 ring-offset-rack" : ""}`}>
			<span aria-hidden className={`w-1.5 shrink-0 rounded-l-[3px] ${isLive(card) ? "sweep" : "bg-ink/25"}`} />
			<button type="button" onClick={onOpen} className="grid min-w-0 flex-1 cursor-pointer grid-cols-[5.75rem_1fr] text-left @2xl:grid-cols-[5.75rem_1fr_6rem_10rem]">
				<span className="condensed border-r border-ink/25 px-2 py-2 font-mono text-[13px]">{card.id}</span>
				<span className="min-w-0 px-3 py-2">
					<span className="block truncate font-semibold">{card.title}</span>
					<span className="condensed block text-[13px] font-semibold @2xl:hidden">
						{stage}, {status.toLowerCase()}
					</span>
					{card.needsAttentionReason ? (
						<span className="block truncate text-[13px]">{card.needsAttentionReason}</span>
					) : (
						card.brief && <span className="block truncate text-[13px] text-ink/70">{card.brief}</span>
					)}
				</span>
				<span className="condensed hidden border-l border-ink/25 px-2 py-2 text-[14px] @2xl:block">{stage}</span>
				<span className="condensed hidden border-l border-ink/25 px-2 py-2 text-[14px] font-semibold @2xl:block">{status}</span>
			</button>
			<span className="flex items-center border-l border-ink/25 px-2">{action}</span>
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
