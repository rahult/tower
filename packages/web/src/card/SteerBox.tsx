import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { Icon } from "../app/icons.tsx";
import { field } from "../ui.ts";

export function SteerBox({ cardId }: { cardId: string }) {
	const [text, setText] = useState("");
	const steer = useMutation({ mutationFn: () => api.steer(cardId, text.trim()), onSuccess: () => setText("") });
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (text.trim()) steer.mutate();
	};
	return (
		// shrink-0: the transcript above gives way, never this. Sticky bottom keeps it at hand while scrolling.
		<form onSubmit={submit} className="steer shrink-0 px-4 pb-3">
			<label htmlFor="steer" className="label">
				Steer this session
			</label>
			<div className="row">
				<textarea
					id="steer"
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
					}}
					rows={1}
					className={`${field} resize-y`}
					placeholder="Use the existing logger instead of adding a new one"
				/>
				<button type="submit" disabled={!text.trim() || steer.isPending} className="btn primary whitespace-nowrap">
					<Icon name="send" />
					Send
				</button>
			</div>
			<span className="meta">
				<span className="kbd">⌘↵</span> sends. The agent reads it after its current tool calls finish.
			</span>
			{steer.error && <p className="text-[14px] text-danger">{steer.error.message}</p>}
		</form>
	);
}
