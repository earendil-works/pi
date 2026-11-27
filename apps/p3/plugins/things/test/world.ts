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
	defineFacet,
	type Facet,
	type Host,
	type HostError,
	openStore,
	type P3Principal,
	type PluginFacet,
	Server,
	sqliteBackend,
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { SignIns } from "../../sign-in/contract.ts";
import thingsServer from "../server.ts";
import { BOARD } from "./kinds.ts";

/** The things plugin as a host loads it. */
export const THINGS: PluginFacet<P3Principal> = { name: "@earendil-works/p3-things", facet: thingsServer };

/**
 * The base's `ServerRuntime` as far as the things plugin reads it (the machine's user, "ann": it names the owner's
 * person at the first start), which a test host serves in the base's place (as `p3.server`, the base's name: `world`
 * loads it unless `more` brings a `p3.server` of its own); loaded beside `THINGS`.
 */
export const RUNTIME: PluginFacet<P3Principal> = {
	name: "p3.server",
	facet: defineFacet((host) =>
		host.serve(ServerRuntime, {
			// The things plugin reads its machine only.
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

/**
 * A host at `Server()` with the things plugin, the base's runtime (`RUNTIME`, unless `more` brings one), the test kind
 * and `more` loaded, on a store in a file of its own, or in the file at `at` (a store an older version wrote: the
 * caller removes it).
 */
export async function world(
	context: Context,
	more: readonly PluginFacet<P3Principal>[] = [],
	at?: string,
): Promise<World> {
	const dir = await mkdtemp(join(tmpdir(), "p3-things-"));
	const path = at ?? join(dir, "store.sqlite");
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
	const base = more.some(({ name }) => name === RUNTIME.name) ? [] : [RUNTIME];
	let facets: readonly PluginFacet<P3Principal>[] = [THINGS, ...base, BOARD, ...more];
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

/** A sign-in as the stub keeps it. */
type SignIn = {
	id: string;
	label: string;
	kind: "browser" | "device";
	principal: P3Principal;
	created: number;
	lastUsed: number;
};

/**
 * A stand-in for the sign-in plugin's `SignIns` (the store ends a removed person's sign-ins through it): `issue`
 * signs a principal in, `revoked` lists the ids ended, in order.
 */
export function signInsStub(): {
	readonly plugin: PluginFacet<P3Principal>;
	readonly revoked: string[];
	/** While true, `revoke` throws (a sign-in plugin that fails). */
	failing: boolean;
	/** While true, `issue` throws before it issues anything (a signer that is down). */
	failingIssue: boolean;
} {
	const revoked: string[] = [];
	const stub = {
		plugin: undefined as unknown as PluginFacet<P3Principal>,
		revoked,
		failing: false,
		failingIssue: false,
	};
	const plugin: PluginFacet<P3Principal> = {
		name: "test.sign-in",
		facet: defineFacet((host) =>
			host.serve(SignIns, (_params, self) => {
				const list = self.writable<SignIn[]>([]);
				return {
					list: self.derive([list], ([value]) => value),
					issue: async ({ principal, label }) => {
						if (stub.failingIssue) throw new Error("the signer is down");
						const id = crypto.randomUUID();
						const signIn: SignIn = { id, label, kind: "browser", principal, created: 0, lastUsed: 0 };
						list.set([...list.value, signIn]);
						return { id, token: id, cookie: "" };
					},
					verify: async () => null,
					revoke: async (id) => {
						if (stub.failing) throw new Error("the sign-in plugin failed");
						revoked.push(id);
						list.set(list.value.filter((signIn) => signIn.id !== id));
						return null;
					},
				};
			}),
		),
	};
	stub.plugin = plugin;
	return stub;
}
