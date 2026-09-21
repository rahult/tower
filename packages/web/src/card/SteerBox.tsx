import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { button, field } from "../ui.ts";

export function SteerBox({ cardId }: { cardId: string }) {
	const [text, setText] = useState("");
	const steer = useMutation({ mutationFn: () => api.steer(cardId, text.trim()), onSuccess: () => setText("") });
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (text.trim()) steer.mutate();
	};
	return (
		// shrink-0: the transcript above gives way, never this.
		<form onSubmit={submit} className="shrink-0 border-t border-rule bg-sheet p-3">
			<label htmlFor="steer" className="mb-1 block text-[13px] text-slate">
				Steer the agent. It reads this after its current tool calls finish.
			</label>
			<div className="flex items-end gap-2">
				<textarea
					id="steer"
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
					}}
					rows={2}
					className={`${field} resize-y`}
					placeholder="Use the existing logger instead of adding a new one"
				/>
				<button type="submit" disabled={!text.trim() || steer.isPending} className={`${button.primary} whitespace-nowrap`}>
					Send steer
				</button>
			</div>
			{steer.error && <p className="mt-1 text-[14px] text-danger">{steer.error.message}</p>}
		</form>
	);
}
