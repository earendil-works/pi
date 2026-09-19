#!/usr/bin/env node

import { type OpenMicroOptions, openMicro } from "./runtime.ts";
import { runMicroTui } from "./tui.ts";

function parseArgs(argv: readonly string[]): OpenMicroOptions {
	const options: OpenMicroOptions = {};
	for (const arg of argv) {
		if (arg === "--continue" || arg === "-c") options.continueSession = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

const micro = await openMicro(parseArgs(process.argv.slice(2)));
try {
	await runMicroTui(micro.view, micro.controller);
} finally {
	await micro.close();
}
