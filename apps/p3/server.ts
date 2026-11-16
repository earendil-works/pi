// The p3 server (decision "Base entries are named after what they are"): `startP3` gives the kit what p3 decides (its
// name, API, kinds, principals, its one worker kind), the kit does the rest. Run as a script it serves `~/.p3` (or the
// directory its first argument names) on port 8789 and prints the owner link.

import { fileURLToPath } from "node:url";
import { type App, startServer } from "@earendil-works/chord/app";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Session } from "@p3/app/v1";
import { API, KINDS, mayReachSession, PRINCIPALS } from "./src/app.ts";
import type { P3Principal } from "./src/principals.ts";

/** p3's port: p2 keeps 8788. */
const PORT = 8789;

/** Starts p3 on `dataDir` (`~/.p3` by default) with its built-in plugins from `root`, listening on `port`. */
export function startP3(
	context: Context,
	options: { readonly dataDir?: string; readonly root?: string; readonly port?: number } = {},
): Promise<App<P3Principal>> {
	return startServer<P3Principal>(
		{
			name: "p3",
			...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
			root: options.root ?? fileURLToPath(new URL("./plugins/", import.meta.url)),
			listen: { host: "127.0.0.1", port: options.port ?? PORT },
			api: API,
			kinds: KINDS,
			principal: PRINCIPALS,
			workers: [
				{
					kind: Session,
					entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
					execArgv: ["--conditions=source", "--disable-warning=ExperimentalWarning"],
					start: () => ({}),
					authorize: mayReachSession,
				},
			],
			onError: (error) => console.error("p3:", error),
		},
		context,
	);
}

if (import.meta.main) {
	const app = await startP3(BACKGROUND_CONTEXT, {
		...(process.argv[2] === undefined ? {} : { dataDir: process.argv[2] }),
	});
	console.log(`p3 on ${app.dataDir}. Open ${app.ownerLink()}`);
}
