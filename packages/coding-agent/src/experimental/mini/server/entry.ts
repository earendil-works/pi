/** Server process entry: `node server/entry.ts <socketPath> <sessionsRoot>`. Spawned detached by the CLI. */

import { socketTransport } from "../shared/transport.ts";
import { runServer } from "./run.ts";

const [socketPath, sessionsRoot] = process.argv.slice(2);
if (!socketPath || !sessionsRoot) throw new Error("Server requires <socketPath> <sessionsRoot>");

void runServer({ transport: socketTransport(socketPath), sessionsRoot }).catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
