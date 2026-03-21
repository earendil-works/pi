#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
process.title = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { createRequire } from "node:module";
import type * as Undici from "undici";
import { main } from "./main.js";

const require = createRequire(import.meta.url);

function hasProxyConfiguration(): boolean {
	return [
		process.env.HTTP_PROXY,
		process.env.HTTPS_PROXY,
		process.env.ALL_PROXY,
		process.env.http_proxy,
		process.env.https_proxy,
		process.env.all_proxy,
	].some((value) => value !== undefined && value.trim() !== "");
}

if (hasProxyConfiguration()) {
	const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici") as typeof Undici;
	setGlobalDispatcher(new EnvHttpProxyAgent());
}

main(process.argv.slice(2));
