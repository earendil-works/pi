// The logins' store (`store.ts`): every statement it runs on its tables (the named query's pages and the writes'
// lookups) searches the key, never scans or sorts; a save during a refresh wins over the refresh's result, and a
// refresh whose caller went away still keeps the token its provider rotated (Astra's reproductions, round 1); the
// device id is made once and kept across a reload.

import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	LoginProviders,
	openStore,
	type P3Principal,
	type PluginFacet,
	Server,
	sqliteBackend,
	withCancel,
} from "@earendil-works/p3/v1";
import { fauxProvider } from "@earendil-works/p3/v1/server";
import { FAUX_PROVIDER, keyOf } from "../../../test/plugins/faux-login/contract.ts";
import thingsServer from "../../things/server.ts";
import { LoginStore } from "../contract.server.ts";
import { PROVIDERS, providerFacets } from "./hosts.ts";

/** A faux credential. */
const CREDENTIAL = { type: "api_key", key: keyOf([]) };

/** A server host on `database` with the things plugin, the providers plugin and `more`; reload renews the providers. */
async function opened(t: TestContext, database: DatabaseSync, more: readonly PluginFacet<P3Principal>[] = []) {
	const store = await openStore(sqliteBackend(new NodeSqliteDatabase(database)), context);
	const host = createHost<P3Principal>({
		address: Server(),
		principal: { kind: "server" },
		store,
		onError: (error) => assert.fail(error.kind),
	});
	let facets: readonly PluginFacet<P3Principal>[] = [
		{ name: "@earendil-works/p3-things", facet: thingsServer },
		...providerFacets(new Set()),
		...more,
	];
	await host.load(facets, context);
	t.after(async () => {
		await host.close(context);
		await store.close(context);
	});
	return {
		store: () => host.get(LoginStore, {}, context),
		reload: async () => {
			facets = facets.map((plugin) =>
				plugin.name === PROVIDERS ? { ...plugin, facet: { ...plugin.facet } } : plugin,
			);
			await host.reload(facets, context);
		},
	};
}

describe("the store's statements", () => {
	it("search the key, never scan or sort", async (t) => {
		const seen = new Set<string>();
		const database = new DatabaseSync(":memory:");
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
		const store = await (await opened(t, database)).store();
		await store.save({ thing: "t1", provider: FAUX_PROVIDER, credential: CREDENTIAL }, context);
		await store.save({ thing: "t1", provider: FAUX_PROVIDER, credential: CREDENTIAL }, context);
		await store.save({ thing: "t2", provider: FAUX_PROVIDER, credential: CREDENTIAL }, context);
		assert.equal((await store.logins.one.page({ thing: "t1" }, 1, context)).items.length, 1);
		await store.authorize({ thing: "t1" }, context);
		await store.device({}, context);
		await store.remove({ thing: "t1" }, context);
		const lookups = [...seen].filter((sql) => /^(SELECT|UPDATE|DELETE)\b/.test(sql));
		assert.ok(lookups.length > 0);
		for (const sql of lookups) {
			const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`)
				.all(
					...sql
						.split("?")
						.slice(1)
						.map(() => 0),
				)
				.map((step) => String(step.detail));
			const bad = plan.filter((step) => /^SCAN /.test(step) || step.includes("TEMP B-TREE"));
			assert.deepEqual(bad, [], `${sql}: ${plan.join(" | ")}`);
		}
	});
});

/**
 * A provider (`gated`) whose refresh waits for `release` after it began (`entered`) and rotates the token (or, with
 * `refuses`, is refused); a second refresh of the same token is refused, as a provider that rotates refresh tokens does.
 */
function gated(refuses = false) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let refreshes = 0;
	const facet = defineFacet((_host, self) =>
		self.contribute(LoginProviders, [
			{
				...fauxProvider({ provider: "gated", api: "gated", models: [{ id: "m" }] }).provider,
				auth: {
					oauth: {
						name: "gated",
						login: async () => {
							throw new Error("no sign-in");
						},
						refresh: async (credential) => {
							if (++refreshes > 1) throw new Error("already rotated");
							entered.resolve();
							await release.promise;
							if (refuses) throw new Error("invalid_grant");
							return { ...credential, access: "rotated", refresh: "rotated", expires: Date.now() + 3_600_000 };
						},
						toAuth: async (credential) => ({ apiKey: credential.access }),
					},
				},
			},
		]),
	);
	return { entered, release, plugin: { name: "gated", facet } };
}

/** An expired token of the gated provider. */
const OLD = { type: "oauth", access: "old", refresh: "old", expires: 0 };

describe("credentials while a refresh runs", () => {
	it("a save during a refresh wins over the refresh's result", async (t) => {
		const { entered, release, plugin } = gated();
		const store = await (await opened(t, new DatabaseSync(":memory:"), [plugin])).store();
		await store.save({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = store.authorize({ thing: "t" }, context);
		await entered.promise;
		const newer = { ...OLD, access: "newer-login", expires: Date.now() + 3_600_000 };
		const replaced = store.save({ thing: "t", provider: "gated", credential: newer }, context);
		release.resolve();
		await Promise.all([first, replaced]);
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "newer-login");
	});

	it("a refresh refused after a save does not mark the newer credential refused", async (t) => {
		const { entered, release, plugin } = gated(true);
		const store = await (await opened(t, new DatabaseSync(":memory:"), [plugin])).store();
		await store.save({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = store.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		const newer = { ...OLD, access: "newer-login", expires: Date.now() + 3_600_000 };
		await store.save({ thing: "t", provider: "gated", credential: newer }, context);
		release.resolve();
		await first;
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "newer-login");
	});

	it("a save through the next object of a reload wins over the older object's refresh", async (t) => {
		const { entered, release, plugin } = gated();
		const host = await opened(t, new DatabaseSync(":memory:"), [plugin]);
		const older = await host.store();
		await older.save({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = older.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		await host.reload();
		const next = await host.store();
		const newer = { ...OLD, access: "newer-login", expires: Date.now() + 3_600_000 };
		await next.save({ thing: "t", provider: "gated", credential: newer }, context);
		release.resolve();
		await first;
		assert.equal((await next.authorize({ thing: "t" }, context)).auth.apiKey, "newer-login");
	});

	it("a refresh whose caller went away keeps the token its provider rotated", async (t) => {
		const { entered, release, plugin } = gated();
		const store = await (await opened(t, new DatabaseSync(":memory:"), [plugin])).store();
		await store.save({ thing: "t", provider: "gated", credential: OLD }, context);
		const caller = withCancel(context);
		const first = store.authorize({ thing: "t" }, caller.context).catch(() => undefined);
		await entered.promise;
		caller.cancel(new Error("the caller went away"));
		release.resolve();
		await first;
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "rotated");
	});
});

describe("the device id", () => {
	it("is made once and the same ever after, a reload too", async (t) => {
		const host = await opened(t, new DatabaseSync(":memory:"));
		const id = await (await host.store()).device({}, context);
		assert.equal(await (await host.store()).device({}, context), id);
		await host.reload();
		assert.equal(await (await host.store()).device({}, context), id);
	});
});
