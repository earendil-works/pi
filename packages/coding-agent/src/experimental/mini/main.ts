/**
 * The `mini` command. Runs the presentation host.
 *
 * Run: node packages/coding-agent/src/experimental/mini/main.ts [--continue]
 */

import { runTui, type TuiOptions } from "./tui/run.ts";

function parseArgs(argv: readonly string[]): TuiOptions {
	const options: TuiOptions = {};
	for (const arg of argv) {
		if (arg === "--continue" || arg === "-c") options.continueSession = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

runTui(parseArgs(process.argv.slice(2))).then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
