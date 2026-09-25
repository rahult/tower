// Notes: a tiny JSON-file store. Commands read and write a plain file, so every behaviour is testable
// without mocks and every run can use a throwaway file (see acceptance/helpers.mjs).
import { readFile, writeFile } from "node:fs/promises";

async function load(store) {
	try {
		return JSON.parse(await readFile(store, "utf8"));
	} catch {
		return [];
	}
}

export async function addNote(text, store) {
	if (typeof text !== "string" || text.trim() === "") {
		return { message: "usage: cli notes:add <text>", exitCode: 64, error: true };
	}
	const notes = await load(store);
	notes.push({ text: text.trim(), at: new Date().toISOString() });
	await writeFile(store, JSON.stringify(notes, null, 2));
	return { message: `noted (${notes.length} total)`, exitCode: 0 };
}

export async function listNotes(store) {
	const notes = await load(store);
	if (notes.length === 0) return { message: "(no notes)", exitCode: 0 };
	return { message: notes.map((note, index) => `${index + 1}. ${note.text}`).join("\n"), exitCode: 0 };
}
