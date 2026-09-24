export interface Note {
	id: number;
	body: string;
	createdAt: string;
}

/** The typed client for the backend. Every call answers with the status so screens can react, not guess. */
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
	const response = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await response.text();
	return { status: response.status, data: text === "" ? null : (JSON.parse(text) as T) };
}

export const api = {
	health: () => call<{ ok: boolean }>("GET", "/api/health"),
	listNotes: () => call<Note[]>("GET", "/api/notes"),
	addNote: (body: string) => call<Note | { error: string }>("POST", "/api/notes", { body }),
	deleteNote: (id: number) => call<null>("DELETE", `/api/notes/${id}`),
};
