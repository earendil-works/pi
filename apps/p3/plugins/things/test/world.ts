// The things plugin's tests' host: the things plugin's server facet and the test kind's (`kinds.ts`), loaded as
// modules on a host with a SQLite store in a file of its own (the differential test's reference reads it directly)
// and the in-memory telemetry adapter (counted work); `reload` renews a plugin's facet object, as after an edit, and
// `rows` reads a table of the things store from the file, as the tests check what is on disk.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	type ChordStore,
	type Context,
	createHost,
	type Facet,
	type Host,
	type HostError,
	openStore,
	type P3Principal,
	type PluginFacet,
	defineFacet,
	Server,
	sqliteBackend,
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import thingsServer from "../server.ts";
import { BOARD } from "./kinds.ts";

/** The things plugin as a host loads it. */
export const THINGS: PluginFacet<P3Principal> = { name: "@earendil-works/p3-things", facet: thingsServer };

/**
 * The base's `ServerRuntime` as far as the things plugin reads it (the machine's user names the owner's person at
 * the first start); a real server's base contributes the whole value.
 */
export const RUNTIME: PluginFacet<P3Principal> = {
	name: "p3.server",
	// The things store reads `machine` only: the rest of a server's runtime is no part of these tests.
	facet: defineFacet((host) =>
		host.serve(ServerRuntime, {
			compose: () => ({ machine: { user: "ann", hostname: "test" } }) as unknown as ServerRuntime,
		}),
	),
};

/** A running test host. */
export type World = {
	readonly host: Host<P3Principal>;
	/** The store's SQLite file. */
	readonly path: string;
	/** What the host reported. */
	readonly errors: readonly HostError[];
	/** The sum of metric `name` so far (`things.access.reads`, `chord.query.runs`, ...). */
	count(name: string): number;
	/** Every row of the things store's table `table` (`grants`, `pending`, ...) as the file has it now. */
	rows(table: string): Record<string, SQLOutputValue>[];
	/** Renews plugin `name`'s facet object (or replaces it with `facet`): its objects restart, as after an edit. */
	reload(name: string, context: Context, facet?: Facet<P3Principal>): Promise<void>;
	close(context: Context): Promise<void>;
};

/** A host at `Server()` with the things plugin, the test kind and `more` loaded. */
export async function world(context: Context, more: readonly PluginFacet<P3Principal>[] = []): Promise<World> {
	const dir = await mkdtemp(join(tmpdir(), "p3-things-"));
	const path = join(dir, "store.sqlite");
	const store: ChordStore = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	const telemetry = new InMemoryTelemetryContext();
	const errors: HostError[] = [];
	const host = createHost<P3Principal>({
		address: Server(),
		principal: { kind: "server" },
		store,
		telemetry,
		readyTimeout: 5000,
		onError: (error) => errors.push(error),
	});
	let facets: readonly PluginFacet<P3Principal>[] = [RUNTIME, THINGS, BOARD, ...more];
	const loaded = await host.load(facets, context);
	if (loaded.failed.length > 0) throw new Error("world: plugins failed", { cause: loaded.failed[0]!.error });
	return {
		host,
		path,
		errors,
		count: (name) =>
			telemetry
				.getMetrics()
				.filter((metric) => metric.name === name)
				.reduce((sum, metric) => sum + metric.value, 0),
		rows: (table) => storedRows(path, table),
		reload: async (name, ctx, facet) => {
			facets = facets.map((plugin) =>
				plugin.name === name ? { ...plugin, facet: facet ?? { ...plugin.facet } } : plugin,
			);
			const report = await host.reload(facets, ctx);
			if (report.failed.length > 0) throw new Error("world: reload failed", { cause: report.failed[0]!.error });
		},
		close: async (ctx) => {
			await host.close(ctx);
			await store.close(ctx);
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** Every row of the things store's table `table` in the SQLite file at `path`, read through a connection of its own. */
export function storedRows(path: string, table: string): Record<string, SQLOutputValue>[] {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return database.prepare(`SELECT * FROM "things.store:things.${table}"`).all();
	} finally {
		database.close();
	}
}
