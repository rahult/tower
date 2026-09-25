// The store. One sqlite file, real SQL, zero dependencies: node:sqlite is the standard library's own
// store, and the schema lives in code so a fresh checkout is a working database.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export class Store {
	constructor(file = defaultFile()) {
		mkdirSync(dirname(file), { recursive: true });
		this.sqlite = new DatabaseSync(file);
		this.sqlite.exec("PRAGMA journal_mode = WAL");
		this.migrate();
	}

	migrate() {
		this.sqlite.exec(`
			CREATE TABLE IF NOT EXISTS items (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			);
		`);
	}

	close() {
		this.sqlite.close();
	}

	list() {
		return this.sqlite.prepare("SELECT id, name, created_at AS createdAt FROM items ORDER BY id").all();
	}

	add(name) {
		const result = this.sqlite.prepare("INSERT INTO items (name) VALUES (?)").run(name);
		return this.sqlite.prepare("SELECT id, name, created_at AS createdAt FROM items WHERE id = ?").get(Number(result.lastInsertRowid));
	}
}

function defaultFile() {
	return process.env.APP_DB ?? join(process.cwd(), "data", "app.sqlite");
}
