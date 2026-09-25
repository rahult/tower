#!/usr/bin/env node
// The entry point: parse argv, dispatch to one command, exit with its status.
// Commands live in src/commands/ — one file, one job, exported for tests as well as the dispatcher.
import { dispatch } from "../src/cli.js";

const [command, ...args] = process.argv.slice(2);
const outcome = dispatch(command, args);

if (outcome.error) {
	console.error(outcome.message);
	process.exit(outcome.exitCode);
}
console.log(outcome.message);
process.exit(outcome.exitCode);
