// The logins' store (`store.ts`): every statement it runs on its tables and on the types' catalogs (the named queries'
// pages and the writes' lookups) searches the key, never scans or sorts; a credential is created once and replaced only
// with one of its own provider; a refresh keeps the token its provider rotated whatever ends meanwhile (its caller, the
// store's object in a reload) and is written over the credential it read only (a replacement, a removal and a new login
// meanwhile win); one refresh at a time across a reload, a clock set forward too, a refresh still running never taken
// over (its waiter fails), a lease of a process that is gone holding nothing; a rotation is stored when its account's
// models cannot be told, nothing of the provider's error logged; a failed refresh refuses the login for a while (a
// request that waited for it too), then one request tries again, and a success clears it; a failed derivation of an
// unexpired token refuses nothing (Astra's and Opus's reproductions, rounds 1 to 4); the device id is made once and
// kept across a reload.

import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	type Credential,
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
import { eventually } from "../../../test/until.ts";
import thingsServer from "../../things/server.ts";
import { CatalogStore, LoginStore } from "../contract.server.ts";
import { PROVIDERS, providerFacets, providersWorld } from "./hosts.ts";

/** A faux credential. */
const CREDENTIAL = { type: "api_key", key: keyOf([]) };

/** An expired token. */
const OLD = { type: "oauth", access: "old", refresh: "old", expires: 0 };

/** A token valid for an hour. */
const valid = (access: string) => ({ ...OLD, access, expires: Date.now() + 3_600_000 });

/**
 * The things plugin's test host with the providers plugin and `more`; its store, a reload of the providers, and login
 * `thing`'s row as the store's file holds it.
 */
async function served(t: TestContext, more: readonly PluginFacet<P3Principal>[] = []) {
	const w = await providersWorld(context, new Set(), more);
	t.after(() => w.close(context));
	return {
		store: () => w.host.get(LoginStore, {}, context),
		reload: () => w.reload(PROVIDERS, context),
		stored: (thing: string) => {
			const database = new DatabaseSync(w.path, { readOnly: true });
			try {
				const select = 'SELECT * FROM "providers.store:providers.logins" WHERE thing = ?';
				return database.prepare(select).get(thing)!;
			} finally {
				database.close();
			}
		},
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
		// The types' catalogs: a write and a read by provider (the login's models read it, `authorize`'s cut too).
		const catalogs = await host.get(CatalogStore, {}, context);
		await catalogs.write({ provider: "gated", entry: { models: [], lastModified: 0, checkedAt: 1 } }, context);
		assert.equal((await catalogs.catalogs.one.page({ provider: "gated" }, 1, context)).items.length, 1);
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

describe("a rotation", () => {
	it("is stored, its lease released, when its provider cannot tell the account's models (Astra)", async (t) => {
		const base = fauxProvider({ provider: "unlisted", api: "unlisted", models: [{ id: "m" }] }).provider;
		const unlisted = {
			name: "unlisted",
			facet: defineFacet((_host, self) =>
				self.contribute(LoginProviders, [
					{
						...base,
						filterModels: (models, credential) => {
							if (credential?.type === "oauth" && credential.access === "fresh")
								throw new Error("no account list");
							return models;
						},
						auth: {
							oauth: {
								name: "unlisted",
								login: async () => {
									throw new Error("no sign-in");
								},
								refresh: async (credential) => ({
									...credential,
									access: "fresh",
									refresh: "fresh",
									expires: Date.now() + 3_600_000,
								}),
								toAuth: async (credential) => ({ apiKey: credential.access }),
							},
						},
					},
				]),
			),
		};
		const host = await served(t, [unlisted]);
		const store = await host.store();
		await store.create({ thing: "t", provider: "unlisted", credential: OLD }, context);
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "fresh");
		const row = host.stored("t");
		assert.equal(JSON.parse(String(row.credential)).refresh, "fresh");
		assert.equal(row.holder, "");
		// The models known before stay.
		assert.deepEqual(JSON.parse(String(row.models)), ["m"]);
	});

	it("is stored, nothing of its error logged, when the error's name is private or throws (Astra)", async (t) => {
		const base = fauxProvider({ provider: "named", api: "named", models: [{ id: "m" }] }).provider;
		let throws = false;
		const named = {
			name: "named",
			facet: defineFacet((_host, self) =>
				self.contribute(LoginProviders, [
					{
						...base,
						filterModels: (models, credential) => {
							if (credential?.type !== "oauth" || credential.access !== "fresh") return models;
							const error = new Error("listing failed");
							Object.defineProperty(error, "name", {
								get: () => {
									if (throws) throw new Error("no name");
									return "PRIVATE-MARKER";
								},
							});
							throw error;
						},
						auth: {
							oauth: {
								name: "named",
								login: async () => {
									throw new Error("no sign-in");
								},
								refresh: async (credential) => ({
									...credential,
									access: "fresh",
									refresh: "fresh",
									expires: Date.now() + 3_600_000,
								}),
								toAuth: async (credential) => ({ apiKey: credential.access }),
							},
						},
					},
				]),
			),
		};
		const host = await served(t, [named]);
		const store = await host.store();
		const lines: string[] = [];
		const log = console.error;
		console.error = (...args: unknown[]) => lines.push(args.join(" "));
		try {
			for (const thing of ["private", "throwing"]) {
				throws = thing === "throwing";
				await store.create({ thing, provider: "named", credential: OLD }, context);
				assert.equal((await store.authorize({ thing }, context)).auth.apiKey, "fresh");
				assert.equal(JSON.parse(String(host.stored(thing).credential)).refresh, "fresh");
			}
		} finally {
			console.error = log;
		}
		assert.ok(!lines.join("\n").includes("PRIVATE-MARKER"), lines.join("\n"));
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

	it("lets a refresh of an older credential that failed refuse nothing the rotation wrote", async (t) => {
		// Each refresh waits for its own gate; the first rotates the token, the second (the spent token) is refused.
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let refreshes = 0;
		const slow = oauthProvider("slow", {
			refresh: async (credential) => {
				const call = refreshes++;
				entered[call]!.resolve();
				await gates[call]!.promise;
				if (call > 0) throw new Error("invalid_grant");
				return { ...credential, access: "rotated", refresh: "rotated", expires: Date.now() + 3_600_000 };
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		});
		const host = await served(t, [slow]);
		const older = await host.store();
		await older.create({ thing: "t", provider: "slow", credential: OLD }, context);
		const first = older.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered[0]!.promise;
		await host.reload();
		await new Promise((resolve) => setTimeout(resolve, 5_500));
		// The lease as a process that is gone would have left it: the next object's request refreshes the token it read too.
		const next = await host.store();
		await next.settle({ thing: "t", version: String(host.stored("t").version), change: { holder: "1@0" } }, context);
		const second = next.authorize({ thing: "t" }, context);
		await entered[1]!.promise;
		gates[0]!.resolve();
		await first;
		// The older call answered its caller at the reload's drain; its rotation is written once its provider answers.
		await eventually(
			async () => JSON.parse(String(host.stored("t").credential)).access,
			(access) => access === "rotated",
			2000,
		);
		// Its refusal comes after the rotation was written: it read the older credential, so it marks nothing.
		gates[1]!.resolve();
		await assert.rejects(second, { code: "providers.signInAgain" });
		assert.equal((await (await host.store()).authorize({ thing: "t" }, context)).auth.apiKey, "rotated");
	});
});

describe("the lease of a refresh", () => {
	it("refuses a request waiting for a refresh that failed, without a refresh of its own (Astra)", async (t) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let refreshes = 0;
		const failing = oauthProvider("failing", {
			refresh: async () => {
				refreshes++;
				entered.resolve();
				await release.promise;
				throw new TypeError("fetch failed");
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		});
		const host = await served(t, [failing]);
		const older = await host.store();
		await older.create({ thing: "t", provider: "failing", credential: OLD }, context);
		const first = older.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		await host.reload();
		await new Promise((resolve) => setTimeout(resolve, 5_500));
		const next = (await host.store()).authorize({ thing: "t" }, context);
		await new Promise((resolve) => setTimeout(resolve, 200));
		release.resolve();
		await first;
		await assert.rejects(next, { code: "providers.signInAgain" });
		assert.equal(refreshes, 1);
	});

	it("is not taken over by a clock set forward while its refresh runs (Astra)", async (t) => {
		const { entered, release, plugin } = gated();
		const host = await served(t, [plugin]);
		const older = await host.store();
		await older.create({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = older.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		await host.reload();
		await new Promise((resolve) => setTimeout(resolve, 5_500));
		const now = Date.now;
		Date.now = () => now() + 61_000;
		try {
			const next = (await host.store()).authorize({ thing: "t" }, context);
			await new Promise((resolve) => setTimeout(resolve, 200));
			release.resolve();
			await first;
			// A second refresh of the same token would be refused ("already rotated").
			assert.equal((await next).auth.apiKey, "rotated");
		} finally {
			Date.now = now;
		}
	});

	it("of a running refresh is never taken: a request waiting a minute fails, sending nothing (Astra)", async (t) => {
		const { entered, release, plugin } = gated();
		const host = await served(t, [plugin]);
		const older = await host.store();
		await older.create({ thing: "t", provider: "gated", credential: OLD }, context);
		const first = older.authorize({ thing: "t" }, context).catch(() => undefined);
		await entered.promise;
		await host.reload();
		await new Promise((resolve) => setTimeout(resolve, 5_500));
		const next = (await host.store()).authorize({ thing: "t" }, context);
		await new Promise((resolve) => setTimeout(resolve, 200));
		// A minute on the process's clock: the first refresh (its provider ignoring the abort) still runs.
		const now = performance.now.bind(performance);
		performance.now = () => now() + 61_000;
		try {
			// A second refresh of the same token would be refused ("already rotated") and mark the login.
			await assert.rejects(next, { code: "providers.authFailed" });
		} finally {
			performance.now = now;
		}
		release.resolve();
		await first;
		assert.equal((await (await host.store()).authorize({ thing: "t" }, context)).auth.apiKey, "rotated");
	});

	it("of a server process that is gone (a restart) holds nothing", { timeout: 5_000 }, async (t) => {
		const { release, plugin } = gated();
		release.resolve();
		const host = await served(t, [plugin]);
		const store = await host.store();
		await store.create({ thing: "t", provider: "gated", credential: OLD }, context);
		const { version } = host.stored("t");
		const change = { holder: "1@0" };
		await store.settle({ thing: "t", version: String(version), change }, context);
		assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "rotated");
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

	it("is forgotten when a request succeeds again without a refresh (Astra)", async (t) => {
		let resolves = false;
		const base = fauxProvider({ provider: "keyed", api: "keyed", models: [{ id: "m" }] }).provider;
		const resolve = async ({ credential }: { credential?: Credential }) =>
			resolves && credential?.type === "api_key" ? { auth: { apiKey: credential.key } } : undefined;
		const keyed = {
			name: "keyed",
			facet: defineFacet((_host, self) =>
				self.contribute(LoginProviders, [{ ...base, auth: { apiKey: { name: "keyed", resolve } } }]),
			),
		};
		const store = await (await served(t, [keyed])).store();
		await store.create({ thing: "t", provider: "keyed", credential: { type: "api_key", key: "k" } }, context);
		await assert.rejects(store.authorize({ thing: "t" }, context), { code: "providers.signInAgain" });
		resolves = true;
		const now = Date.now;
		Date.now = () => now() + 2 * 60_000 + 1000;
		try {
			assert.equal((await store.authorize({ thing: "t" }, context)).auth.apiKey, "k");
		} finally {
			Date.now = now;
		}
		assert.equal((await store.logins.one.page({ thing: "t" }, 1, context)).items[0]?.status, "signedIn");
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
