#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
process.title = "pi";
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";
import { killAllTrackedChildren } from "./utils/shell.js";

// When the controlling terminal closes it sends SIGHUP to the foreground
// process group.  Child processes spawned with `detached: true` live in their
// own process groups and never receive this signal, so they would keep running
// as orphans (reparented to PID 1) forever.  Explicitly kill them before exit.
// SIGTERM is handled for the same reason (e.g. `kill <pid>`, system shutdown).
for (const sig of ["SIGHUP", "SIGTERM"] as const) {
	process.on(sig, () => {
		killAllTrackedChildren();
		process.exit(0);
	});
}

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2));
