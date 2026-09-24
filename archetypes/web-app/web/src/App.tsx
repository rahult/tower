import { useCallback, useEffect, useState } from "react";
import { api, type Note } from "./api.ts";

/**
 * The app shell, with the notes example as the worked slice: list, create, delete — the shape every
 * feature copies. Accessibility is not a layer: labelled inputs, real buttons, a live region for
 * async outcomes, and a flow that is complete from the keyboard.
 */
export function App() {
	const [notes, setNotes] = useState<Note[] | null>(null);
	const [draft, setDraft] = useState("");
	const [notice, setNotice] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const { data } = await api.listNotes();
		setNotes(data ?? []);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const add = async (event: React.FormEvent) => {
		event.preventDefault();
		const body = draft.trim();
		if (!body) return;
		const { status } = await api.addNote(body);
		if (status === 201) {
			setDraft("");
			setNotice(`Added “${body}”.`);
			void refresh();
		} else if (status === 409) {
			setNotice("That note already exists.");
		} else {
			setNotice("The note could not be added.");
		}
	};

	const remove = async (note: Note) => {
		const { status } = await api.deleteNote(note.id);
		setNotice(status === 204 ? `Deleted “${note.body}”.` : "The note could not be deleted.");
		if (status === 204) void refresh();
	};

	return (
		<main className="shell">
			<h1>Notes</h1>
			<p className="lead">A worked example — the first feature replaces it, following its shape.</p>

			<form
				className="composer"
				onSubmit={(event) => void add(event)}
			>
				<label htmlFor="note-body">New note</label>
				<div className="row">
					<input
						id="note-body"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						placeholder="Write something down…"
						maxLength={2000}
					/>
					<button type="submit" disabled={draft.trim() === ""}>
						Add
					</button>
				</div>
			</form>

			<p role="status" aria-live="polite" className={notice ? "notice" : "sr-only"}>
				{notice ?? ""}
			</p>

			{notes === null ? (
				<p className="empty">Loading…</p>
			) : notes.length === 0 ? (
				<p className="empty">Nothing here yet — the first note is yours.</p>
			) : (
				<ul className="notes" aria-label="Notes">
					{notes.map((note) => (
						<li key={note.id}>
							<span className="body">{note.body}</span>
							<button type="button" className="ghost" onClick={() => void remove(note)} aria-label={`Delete note: ${note.body}`}>
								Delete
							</button>
						</li>
					))}
				</ul>
			)}
		</main>
	);
}
