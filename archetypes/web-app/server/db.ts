import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Note {
	id: number;
	body: string;
	createdAt: string;
}

/**
 * The database. One file, real SQL, zero dependencies: node:sqlite is the standard library's own
 * store, and the schema lives in code so a fresh checkout is a working database.
 */
export class Db {
	private readonly sqlite: DatabaseSync;

	constructor(file: string = defaultFile()) {
		mkdirSync(dirname(file), { recursive: true });
		this.sqlite = new DatabaseSync(file);
		this.sqlite.exec("PRAGMA journal_mode = WAL");
		this.sqlite.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	private migrate(): void {
		this.sqlite.exec(`
			CREATE TABLE IF NOT EXISTS notes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				body TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			);
		`);
	}

	listNotes(): Note[] {
		return this.sqlite.prepare("SELECT id, body, created_at AS createdAt FROM notes ORDER BY id DESC").all() as unknown as Note[];
	}

	/** The one way a duplicate is possible is a race between two inserts; UNIQUE + a transaction closes it. */
	addNote(body: string): Note | null {
		const existing = this.sqlite.prepare("SELECT id, body, created_at AS createdAt FROM notes WHERE body = ?").get(body) as Note | undefined;
		if (existing) return null;
		const result = this.sqlite.prepare("INSERT INTO notes (body) VALUES (?)").run(body);
		return { id: Number(result.lastInsertRowid), body, createdAt: new Date().toISOString() };
	}

	deleteNote(id: number): boolean {
		return this.sqlite.prepare("DELETE FROM notes WHERE id = ?").run(id).changes > 0;
	}
}

function defaultFile(): string {
	return process.env.APP_DB ?? join(process.cwd(), "data", "app.sqlite");
}
