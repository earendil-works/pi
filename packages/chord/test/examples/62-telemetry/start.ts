// The tally app's start: `startServer` with the app's telemetry store, a SQLite file in the data directory. The server
// is its only writer: each worker sends what it records to the server, so one trace reads tab → server → worker.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../../../src/context/index.ts";
import { type App, startServer } from "../../../src/node/app/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { createSqliteTelemetry, type SqliteTelemetry } from "../../../src/telemetry-sqlite/index.ts";
import type { TallyPrincipal } from "./app/principals.ts";
import * as v1 from "./app/v1.ts";

/** The app's API: its name, versions and this process's modules (the worker's entry has the same). */
export const API = { name: "@tally/app", versions: ["v1"], modules: { "@tally/app/v1": v1 } };

/** The app's facet kinds. */
export const KINDS = { server: { platform: "node" }, worker: { platform: "node" } } as const;

/** The telemetry store every process of the app at `dataDir` records to. */
export function telemetryFile(dataDir: string): string {
	return join(dataDir, "telemetry.sqlite");
}

/** Opens the SQLite telemetry store at `path` (the server's). */
export async function openTelemetry(path: string): Promise<SqliteTelemetry> {
	return createSqliteTelemetry(await openNodeSqliteDatabase(path));
}

/** Starts the tally app on a free loopback port with its data in `dataDir`, recording to `telemetry`. */
export function startTally(
	dataDir: string,
	telemetry: SqliteTelemetry,
	context: Context,
): Promise<App<TallyPrincipal>> {
	return startServer<TallyPrincipal>(
		{
			name: "tally",
			dataDir,
			root: fileURLToPath(new URL("./plugins/", import.meta.url)),
			listen: { host: "127.0.0.1", port: 0 },
			api: API,
			kinds: KINDS,
			principal: {
				server: { kind: "server" },
				worker: (address) => ({ kind: "worker", tally: address.key }),
				owner: { kind: "owner" },
			},
			telemetry,
			workers: [
				{
					kind: v1.Tally,
					entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
					execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
					start: () => ({}),
					// The owner reaches a tally through the server, which relays.
					authorize: (principal) => principal.kind === "owner" || principal.kind === "server",
				},
			],
			onError: (error) => console.error("app:", error.kind, error.error),
		},
		context,
	);
}
