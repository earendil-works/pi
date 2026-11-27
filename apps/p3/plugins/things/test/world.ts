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
	defineTable,
	eq,
	type Facet,
	type Host,
	type HostError,
	int,
	invalid,
	json,
	oneOf,
	openStore,
	P3Principal,
	type PluginFacet,
	query,
	Server,
	sqliteBackend,
	str,
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

/** The stand-in's sign-ins: one row each, by person as the real table has them. */
const StubSignIns = defineTable("test.sign-ins", {
	version: 1,
	columns: {
		id: str(),
		label: str(),
		kind: json(oneOf("browser", "device"), { version: 1 }),
		principal: json(P3Principal, { version: 1 }),
		person: str(),
		created: int(),
		lastUsed: int(),
	},
	key: ["id"],
	indexes: { by_person: ["person", "created"] },
});

/**
 * A stand-in for the sign-in plugin's `SignIns` (the store ends a removed person's sign-ins through it): `issue`
 * signs a principal in, `revoked` lists the ids ended, in order.
 */
export function signInsStub(): {
	readonly plugin: PluginFacet<P3Principal>;
	readonly revoked: string[];
	/** While true, `revoke` throws (a sign-in plugin that fails). */
	failing: boolean;
	/**
	 * How `issue` fails: `before` with a typed refusal before it issues anything (a definite failure), `after` once it
	 * issued (its answer lost: an ambiguous one); `undefined`, never.
	 */
	issueFails: "before" | "after" | undefined;
} {
	const revoked: string[] = [];
	const stub = {
		plugin: undefined as unknown as PluginFacet<P3Principal>,
		revoked,
		failing: false,
		issueFails: undefined as "before" | "after" | undefined,
	};
	const plugin: PluginFacet<P3Principal> = {
		name: "test.sign-in",
		facet: defineFacet((host) =>
			host.serve(SignIns, (_params, self) => {
				const table = self.table(StubSignIns);
				const revoke = async (id: string, ctx: Context) => {
					if (stub.failing) throw new Error("the sign-in plugin failed");
					revoked.push(id);
					await self.tx(async (tx) => {
						tx.delete(table, { id });
						return null;
					}, ctx);
					return null;
				};
				return {
					rows: self.queries(
						table,
						{
							map: ({ id, label, kind, principal, created, lastUsed }) => ({
								id,
								label,
								kind,
								principal,
								created,
								lastUsed,
							}),
						},
						{
							ofPerson: ({ person }: { person: string }) =>
								query(StubSignIns)
									.where((r) => eq(r.person, person))
									.orderBy((r) => r.created, "asc"),
							all: (_args: Record<never, never>) => query(StubSignIns),
						},
					),
					issue: async ({ principal, label }, ctx) => {
						if (stub.issueFails === "before") throw invalid("args", "the signer refused");
						const id = crypto.randomUUID();
						const person = principal.kind === "person" ? principal.id : "";
						const row = { id, label, kind: "browser", principal, person, created: 0, lastUsed: 0 } as const;
						await self.tx(async (tx) => {
							tx.put(table, row);
							return null;
						}, ctx);
						if (stub.issueFails === "after") throw new Error("the signer's answer was lost");
						return { id, token: id, cookie: "" };
					},
					verify: async () => null,
					revoke,
					revokeOf: async ({ person }, ctx) => {
						const mine = query(StubSignIns).where((r) => eq(r.person, person));
						for (const { id } of (await table.page(mine, 1000, ctx)).items) await revoke(id, ctx);
						return null;
					},
				};
			}),
		),
	};
	stub.plugin = plugin;
	return stub;
}
