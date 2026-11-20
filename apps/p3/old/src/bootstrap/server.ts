// The p3 server (decision "Base entries are named after what they are"): `startP3` gives the kit what the start
// decides (the data directory, the plugins root, the port, the session worker's entry), the kit does the rest. The
// command that calls it is `bin.ts`.

import type { Context } from "@earendil-works/chord/context";
import { PLUGINS, version, WORKER } from "../install.ts";
import type { App } from "../kit/app.ts";
import { startServer } from "../kit/start-server.ts";
import { firstPort } from "../pi.ts";

/**
 * Starts p3 on `dataDir` (`~/.pi/p3` by default) with its built-in plugins from `root`, listening on `port` for this
 * start, else on the Pi's own port (`firstPort`); `onStop` is what the owner's stop over HTTP does.
 */
export function startP3(
	context: Context,
	options: { readonly onStop: () => void; readonly dataDir?: string; readonly root?: string; readonly port?: number },
): Promise<App> {
	const host = "127.0.0.1";
	return startServer(
		{
			...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
			root: options.root ?? PLUGINS,
			listen:
				options.port === undefined ? { host, firstPort: firstPort(options.dataDir) } : { host, port: options.port },
			version: version(),
			worker: WORKER,
			onStop: options.onStop,
			onError: (error) => console.error("p3:", error),
		},
		context,
	);
}
