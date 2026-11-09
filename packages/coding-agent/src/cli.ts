#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { runJobWorker } from "./core/jobs/worker.ts";
import { runPaneClient } from "./core/panes/client.ts";
import { main } from "./main.ts";

setupCli();
const internalMode = process.argv[2];
if (internalMode === "--internal-job-worker" || internalMode === "--internal-pane-client") {
	const argument = process.argv[3];
	if (!argument) throw new Error("Missing internal entry argument");
	const execution = internalMode === "--internal-job-worker" ? runJobWorker(argument) : runPaneClient(argument);
	execution.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
} else {
	main(process.argv.slice(2));
}
