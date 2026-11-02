// The notes app's start: everything the app itself decides, given to `startApp`. The kit does the rest: the data
// directory, the store, the host, HTTP with sessions and the owner link, a workers component for projects, and the
// plugins (`plugins/` here, the app's required root, and `<dataDir>/plugins/`, the user's).
// Examples 53 to 55 call `startNotes`; a real app's `start.ts` calls it with `process.argv[2]` and prints the link.

import { fileURLToPath } from "node:url";
import type { Context } from "../../../../src/context/index.ts";
import { type App, startApp } from "../../../../src/next-node/app/index.ts";
import type { NotesPrincipal } from "./app/principals.ts";
import * as v1server from "./app/v1/server.ts";
import * as v1 from "./app/v1.ts";

/** The app's API: its name, versions (newest first) and this process's modules (the worker's entry has the same). */
export const API = {
	name: "@notes/app",
	versions: ["v1"],
	modules: { "@notes/app/v1": v1, "@notes/app/v1/server": v1server },
};

/** The app's facet kinds. */
export const KINDS = { server: { platform: "node" }, worker: { platform: "node" } } as const;

/** Starts the notes app on a free loopback port with its data in `dataDir`. */
export function startNotes(dataDir: string, context: Context): Promise<App<NotesPrincipal>> {
	return startApp<NotesPrincipal>(
		{
			name: "notes",
			dataDir,
			root: fileURLToPath(new URL("./plugins/", import.meta.url)),
			listen: { host: "127.0.0.1", port: 0 },
			api: API,
			kinds: KINDS,
			principal: { server: { kind: "server" }, worker: (address) => ({ kind: "worker", project: address.key }) },
			workers: [
				{
					kind: v1.Project,
					entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
					// What each project's worker gets as `WorkerInfo.start`.
					start: (address) => ({ project: address.key }),
					// Who may reach a project: the owner (through the server's routes) and the server itself.
					authorize: (principal) => principal.kind === "owner" || principal.kind === "server",
					idleMs: () => 60_000,
				},
			],
			onError: (error) => console.error("app:", error.kind, error.error),
		},
		context,
	);
}
