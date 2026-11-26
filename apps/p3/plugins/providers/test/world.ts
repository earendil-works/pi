// The providers plugin's tests' host for what `testPlugin` has no way to do (a reload, the statements SQLite runs): the
// things plugin's server facet, the faux login's and the providers plugin's, loaded as modules on a host whose store
// is a SQLite database the test gives; `reload` renews the providers plugin's facet object, as after an edit.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	type Context,
	createHost,
	type Host,
	type HostError,
	openStore,
	type P3Principal,
	type PluginFacet,
	Server,
	sqliteBackend,
} from "@earendil-works/p3/v1";
import fauxServer from "../../../test/plugins/faux-login/server.ts";
import thingsServer from "../../things/server.ts";
import providersServer from "../server.ts";

/** The providers plugin's name. */
const PROVIDERS = "@earendil-works/p3-providers";

/** A running test host. */
export type World = {
	readonly host: Host<P3Principal>;
	readonly errors: readonly HostError[];
	/** Renews the providers plugin's facet object: its objects restart, as after an edit. */
	reload(context: Context): Promise<void>;
	close(context: Context): Promise<void>;
};

/**
 * A host at `Server()` on `database` with the things plugin, the faux login, the providers plugin and `more` (test
 * providers) loaded.
 */
export async function world(
	database: DatabaseSync,
	context: Context,
	more: readonly PluginFacet<P3Principal>[] = [],
): Promise<World> {
	const store = await openStore(sqliteBackend(new NodeSqliteDatabase(database)), context);
	const errors: HostError[] = [];
	const host = createHost<P3Principal>({
		address: Server(),
		principal: { kind: "server" },
		store,
		readyTimeout: 5000,
		onError: (error) => errors.push(error),
	});
	let facets: readonly PluginFacet<P3Principal>[] = [
		{ name: "@earendil-works/p3-things", facet: thingsServer },
		{ name: "p3-test-faux-login", facet: fauxServer },
		{ name: PROVIDERS, facet: providersServer },
		...more,
	];
	const loaded = await host.load(facets, context);
	if (loaded.failed.length > 0) throw new Error("world: plugins failed", { cause: loaded.failed[0]!.error });
	return {
		host,
		errors,
		reload: async (ctx) => {
			facets = facets.map((plugin) =>
				plugin.name === PROVIDERS ? { ...plugin, facet: { ...plugin.facet } } : plugin,
			);
			const report = await host.reload(facets, ctx);
			if (report.failed.length > 0) throw new Error("world: reload failed", { cause: report.failed[0]!.error });
		},
		close: async (ctx) => {
			await host.close(ctx);
			await store.close(ctx);
		},
	};
}

/** `database` with every statement on the providers plugin's tables recorded into `seen` as it is prepared. */
export function recording(database: DatabaseSync, seen: Set<string>): DatabaseSync {
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		if (!sql.includes("providers.store:")) return statement;
		// Chord passes positional parameters only.
		const seeing =
			<R>(run: (...parameters: SQLInputValue[]) => R) =>
			(...parameters: SQLInputValue[]): R => {
				seen.add(sql);
				return run(...parameters);
			};
		return Object.assign(statement, {
			run: seeing(statement.run.bind(statement)),
			all: seeing(statement.all.bind(statement)),
			get: seeing(statement.get.bind(statement)),
			iterate: seeing(statement.iterate.bind(statement)),
		});
	};
	return database;
}
