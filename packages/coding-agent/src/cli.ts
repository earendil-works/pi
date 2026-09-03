#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { consumeInternalProcessRole } from "./experimental/process.ts";
import { runServerProcess } from "./experimental/server.ts";
import { runSessionWorkerProcess } from "./experimental/session-worker.ts";
import { main } from "./main.ts";

const internalProcessRole = consumeInternalProcessRole();
if (internalProcessRole === "server") {
	void runServerProcess(process.argv.slice(2)).catch(() => process.exit(1));
} else if (internalProcessRole === "session-worker") {
	void runSessionWorkerProcess(process.argv.slice(2)).catch(() => process.exit(1));
} else {
	if (internalProcessRole !== undefined) {
		throw new Error(`Internal ${internalProcessRole} process must use its lightweight entrypoint`);
	}
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici's global dispatcher before provider SDKs issue requests.
	// Runtime settings are applied once SettingsManager has loaded global/project settings.
	configureHttpDispatcher();

	main(process.argv.slice(2));
}
