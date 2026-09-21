import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";

export function SteerBox({ cardId }: { cardId: string }) {
	const [text, setText] = useState("");
	const steer = useMutation({ mutationFn: () => api.steer(cardId, text.trim()), onSuccess: () => setText("") });
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (text.trim()) steer.mutate();
	};
	return (
		<form onSubmit={submit} className="border-t border-seam p-3">
			<label htmlFor="steer" className="mb-1 block text-[13px] text-dust">
				Steer the agent. It reads this after its current tool calls finish.
			</label>
			<div className="flex gap-2">
				<textarea
					id="steer"
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
					}}
					rows={2}
					className="flex-1 resize-y rounded-[3px] bg-buff px-3 py-2 text-ink placeholder:text-ink/50"
					placeholder="Use the existing logger instead of adding a new one"
				/>
				<button type="submit" disabled={!text.trim() || steer.isPending} className="condensed cursor-pointer self-end rounded-[3px] bg-chalk px-3 py-2 font-semibold text-ink hover:bg-white disabled:cursor-default disabled:opacity-40">
					Send steer
				</button>
			</div>
			{steer.error && <p className="mt-1 text-[14px] text-rose">{steer.error.message}</p>}
		</form>
	);
}
