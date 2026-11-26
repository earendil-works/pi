// The logins' store (`store.ts`): every statement it runs on its tables (the named query's pages and the writes'
// lookups) searches the key, never scans or sorts; a credential is created once and replaced only with one of its own
// provider; a refresh keeps the token its provider rotated whatever ends meanwhile (its caller, the store's object in
// a reload) and is written over the credential it read only (a replacement, a removal and a new login meanwhile win);
// one refresh at a time across a reload; a failed refresh refuses the login for a while, then one request tries
// again; a failed derivation of an unexpired token refuses nothing (Astra's and Opus's reproductions, rounds 1 and 2);
// the device id is made once and kept across a reload.

import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	LoginProviders,
	type OAuthAuth,
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
import { PROVIDERS, providerFacets, providersWorld } from "./hosts.ts";

/** A faux credential. */
const CREDENTIAL = { type: "api_key", key: keyOf([]) };

/** An expired token. */
const OLD = { type: "oauth", access: "old", refresh: "old", expires: 0 };

/** A token valid for an hour. */
const valid = (access: string) => ({ ...OLD, access, expires: Date.now() + 3_600_000 });

/** The things plugin's test host with the providers plugin and `more`; its store, and a reload of the providers. */
async function served(t: TestContext, more: readonly PluginFacet<P3Principal>[] = []) {
	const w = await providersWorld(context, new Set(), more);
	t.after(() => w.close(context));
	return {
		store: () => w.host.get(LoginStore, {}, context),
		reload: () => w.reload(PROVIDERS, context),
	};
}

/** A provider (`id`) with the OAuth `oauth` (its sign-in refused: the tests store credentials themselves). */
function oauthProvider(id: string, oauth: Omit<OAuthAuth, "name" | "login">): PluginFacet<P3Principal> {
	const base = fauxProvider({ provider: id, api: id, models: [{ id: "m" }] }).provider;
	const login = async (): Promise<never> => {
		throw new Error("no sign-in");
	};
	const auth = { oauth: { name: id, login, ...oauth } };
	return { name: id, facet: defineFacet((_host, self) => self.contribute(LoginProviders, [{ ...base, auth }])) };
}

/**
 * A provider (`gated`) whose refresh waits for `release` after it began (`entered`) and rotates the token (or, with
 * `refuses`, is refused); a second refresh of the same token is refused, as a provider rotating refresh tokens does.
 */
function gated(refuses = false) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let refreshes = 0;
	const plugin = oauthProvider("gated", {
		refresh: async (credential) => {
			if (++refreshes > 1) throw new Error("already rotated");
			entered.resolve();
			await release.promise;
			if (refuses) throw new Error("invalid_grant");
			return { ...credential, access: "rotated", refresh: "rotated", expires: Date.now() + 3_600_000 };
		},
		toAuth: async (credential) => ({ apiKey: credential.access }),
	});
	return { entered, release, plugin };
}

describe("the store's statements", () => {
	// Its own host: the statements are recorded as SQLite prepares them.
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
		const stored = await openStore(sqliteBackend(new NodeSqliteDatabase(database)), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store: stored,
			onError: (error) => assert.fail(error.kind),
		});
		t.after(async () => {
			await host.close(context);
			await stored.close(context);
		});
		const facets = [
			{ name: "@earendil-works/p3-things", facet: thingsServer },
			...providerFacets(new Set(), () => host),
		];
		await host.load([...facets, gated().plugin], context);
		const store = await host.get(LoginStore, {}, context);
		await store.create({ thing: "t1", provider: FAUX_PROVIDER, credential: CREDENTIAL }, context);
		await store.replace({ thing: "t1", provider: FAUX_PROVIDER, credential: CREDENTIAL }, context);
		await store.create({ thing: "t2", provider: "gated", credential: valid("a") }, context);
		assert.equal((await store.logins.one.page({ thing: "t1" }, 1, context)).items.length, 1);
		await store.authorize({ thing: "t1" }, context);
		await store.authorize({ thing: "t2" }, context);
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

describe("storing a credential", () => {
	it("creates a login's once; replaces it only with one of the same provider, never one gone", async (t) => {
		const { plugin } = gated();
		const store = await (await served(t, [plugin])).store();
		await store.create({ thing: "t", provider: "gated", credential: OLD }, context);
		await assert.rejects(store.create({ thing: "t", provider: "gated", credential: OLD }, context));
		// A held worker keeps the provider's request code: another provider's credential would reach it.
		await assert.rejects(store.replace({ thing: "t", provider: FAUX_PROVIDER, credential: CREDENTIAL }, context));
		await store.replace({ thing: "t", provider: "gated", credential: valid("again") }, context);
		await store.remove({ thing: "t" }, context);
		await assert.rejects(store.replace({ thing: "t", provider: "gated", credential: valid("late") }, context));
	});
});

describe("credentials while a refresh runs", () => {
	it("a replacement during a refresh wins over the refresh's result", async (t) => {
		const { entered, release, plugin } = gated();
		const store = await (await served(t, [plugin])).store();
		await store.create({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = store.authorize({ thing: "t" }, context);
		await entered.promise;
		const replaced = store.replace({ thing: "t", provider: "gated", credential: valid("newer-login") }, context);
		release.resolve();
		await Promise.all([first, replaced]);
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "newer-login");
	});

	it("a refresh refused after a replacement does not refuse the newer credential", async (t) => {
		const { entered, release, plugin } = gated(true);
		const store = await (await served(t, [plugin])).store();
		await store.create({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = store.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		await store.replace({ thing: "t", provider: "gated", credential: valid("newer-login") }, context);
		release.resolve();
		await first;
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "newer-login");
	});

	it("a removal and a new login of the same id during a refresh win over its result", async (t) => {
		const { entered, release, plugin } = gated();
		const store = await (await served(t, [plugin])).store();
		await store.create({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = store.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		await store.remove({ thing: "t" }, context);
		await store.create({ thing: "t", provider: "gated", credential: valid("newer") }, context);
		release.resolve();
		await first;
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "newer");
	});

	it("a refresh whose caller went away keeps the token its provider rotated", async (t) => {
		const { entered, release, plugin } = gated();
		const store = await (await served(t, [plugin])).store();
		await store.create({ thing: "t", provider: "gated", credential: OLD }, context);
		const caller = withCancel(context);
		const first = store.authorize({ thing: "t" }, caller.context).catch(() => undefined);
		await entered.promise;
		caller.cancel(new Error("the caller went away"));
		release.resolve();
		await first;
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "rotated");
	});
});

describe("a reload while a refresh runs", () => {
	it("keeps the rotation that finishes while the reload drains the old store (Astra)", async (t) => {
		const { entered, release, plugin } = gated();
		const host = await served(t, [plugin]);
		await (await host.store()).create({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = (await host.store()).authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		const reload = host.reload();
		await new Promise((resolve) => setImmediate(resolve));
		release.resolve();
		await Promise.all([first, reload]);
		assert.equal((await (await host.store()).authorize({ thing: "t" }, context)).auth.apiKey, "rotated");
	});

	it("keeps the rotation that finishes after the reload returned (Astra)", async (t) => {
		const { entered, release, plugin } = gated();
		const host = await served(t, [plugin]);
		await (await host.store()).create({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = (await host.store()).authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		await host.reload();
		release.resolve();
		await first;
		assert.equal((await (await host.store()).authorize({ thing: "t" }, context)).auth.apiKey, "rotated");
	});

	it("lets the next object's request wait for the older one's refresh, not refresh the used token (Opus)", async (t) => {
		const { entered, release, plugin } = gated();
		const host = await served(t, [plugin]);
		const older = await host.store();
		await older.create({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = older.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		await host.reload();
		const next = (await host.store()).authorize({ thing: "t" }, context);
		release.resolve();
		await first;
		assert.equal((await next).auth.apiKey, "rotated");
	});

	it("lets the next object, live once the reload cut the older call, wait for that call's refresh", async (t) => {
		const { entered, release, plugin } = gated();
		const host = await served(t, [plugin]);
		const older = await host.store();
		await older.create({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = older.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		await host.reload();
		// The next object goes live once the reload stopped waiting for the older call (5 s); the refresh runs on.
		await new Promise((resolve) => setTimeout(resolve, 5_500));
		const next = (await host.store()).authorize({ thing: "t" }, context);
		await new Promise((resolve) => setTimeout(resolve, 200));
		release.resolve();
		await first;
		assert.equal((await next).auth.apiKey, "rotated");
	});
});

describe("a failed refresh", () => {
	it("refuses the login for a while, then one request tries again, and success clears it (Opus, Fable)", async (t) => {
		let refreshes = 0;
		const flaky = oauthProvider("flaky", {
			refresh: async (credential) => {
				if (++refreshes === 1) throw new TypeError("fetch failed");
				return { ...credential, access: "fresh", expires: Date.now() + 3_600_000 };
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		});
		const store = await (await served(t, [flaky])).store();
		await store.create({ thing: "t", provider: "flaky", credential: OLD }, context);
		const status = async () => (await store.logins.one.page({ thing: "t" }, 1, context)).items[0]?.status;
		await assert.rejects(store.authorize({ thing: "t" }, context), { code: "providers.signInAgain" });
		await assert.rejects(store.authorize({ thing: "t" }, context), { code: "providers.signInAgain" });
		assert.equal(refreshes, 1, "refused at once, no refresh on every request");
		assert.equal(await status(), "signInAgain");
		const now = Date.now;
		Date.now = () => now() + 2 * 60_000 + 1000;
		try {
			assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "fresh");
		} finally {
			Date.now = now;
		}
		assert.equal(await status(), "signedIn");
	});

	it("a failed derivation of an unexpired token refuses nothing (Astra)", async (t) => {
		let derived = 0;
		const flaky = oauthProvider("flaky", {
			refresh: async (credential) => credential,
			toAuth: async (credential) => {
				if (++derived === 1) throw new Error("temporarily unavailable");
				return { apiKey: credential.access };
			},
		});
		const store = await (await served(t, [flaky])).store();
		await store.create({ thing: "t", provider: "flaky", credential: valid("still") }, context);
		await assert.rejects(store.authorize({ thing: "t" }, context), { code: "providers.authFailed" });
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "still");
	});
});

describe("the device id", () => {
	it("is made once and the same ever after, a reload too", async (t) => {
		const host = await served(t);
		const id = await (await host.store()).device({}, context);
		assert.equal(await (await host.store()).device({}, context), id);
		await host.reload();
		assert.equal(await (await host.store()).device({}, context), id);
	});
});
