#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME, VERSION } from "./config.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);

// Fast path: --version / -v must not load the agent session graph.
// Package subcommands are handled later in main (their flags are not version).
const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);
const firstArg = args[0];
const isPackageCommand = firstArg !== undefined && PACKAGE_COMMANDS.has(firstArg);
if (!isPackageCommand && (args.includes("--version") || args.includes("-v"))) {
	console.log(VERSION);
	process.exit(0);
}

// Deferred load: keep metadata flags cheap; full CLI graph is large.
const { configureHttpDispatcher } = await import("./core/http-dispatcher.ts");
const { main } = await import("./main.ts");

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

void main(args);
