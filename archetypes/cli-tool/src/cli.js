// The dispatcher: maps a command name to its handler and normalises what comes back.
// Every handler returns { message, exitCode, error? } — nothing in here writes to the console.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { greet } from "./commands/greet.js";
import { addNote, listNotes } from "./commands/notes.js";

const commands = {
	greet,
	"notes:add": (args) => addNote(args[0], join(process.cwd(), "notes.json")),
	"notes:list": (args) => listNotes(args[0] ? join(process.cwd(), args[0]) : join(process.cwd(), "notes.json")),
};

export function dispatch(command, args = [], store = join(process.cwd(), "notes.json")) {
	if (!command || command === "help") {
		return {
			message: "usage: cli <command> [args]\n\n  greet <name>       a first command, kept as the worked example\n  notes:add <text>   record a note\n  notes:list [file]  list recorded notes",
			exitCode: 0,
		};
	}
	const handler = commands[command];
	if (!handler) {
		return { message: `unknown command: ${command} (try "help")`, exitCode: 64, error: true };
	}
	return command === "notes:add" ? addNote(args[0], store) : command === "notes:list" ? listNotes(args[0] ?? store) : handler(args[0]);
}
