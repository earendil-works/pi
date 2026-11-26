// The logins' store on the server (`LoginStore`): each login's credential, keyed by the login's thing id (a login is a
// thing, made and linked through the things plugin; its credential is this plugin's), the finished sign-ins waiting
// for the create step that makes their login, and the request auth of a login, refreshed here and only here. A
// credential is a plain row for now (sealing at rest comes with ERNDL-703); it never leaves this store but as the
// request auth `authorize` answers. This plugin's own server code only: it checks no caller.

import {
	bool,
	type Context,
	defineTable,
	eq,
	type FacetHost,
	int,
	invalid,
	json,
	lt,
	type P3Principal,
	PluginError,
	query,
	type RegistryValue,
	str,
	type TableItem,
	unknown,
} from "@earendil-works/p3/v1";
import {
	type AuthContext,
	type Credential,
	type CredentialStore,
	createModels,
	type AuthResult as PiAuthResult,
	type Provider,
} from "@earendil-works/p3/v1/server";
import { LoginStore } from "./contract.server.ts";
import { type AuthResult, Method } from "./contract.ts";
import { LoginProviders } from "./login-providers.ts";

/**
 * Every login: its provider, how it signs in, its credential (pi-ai's `Credential`; `null`: signed out) and whether
 * its provider refused the last refresh.
 */
const Logins = defineTable("providers.logins", {
	version: 1,
	columns: {
		thing: str(),
		provider: str(),
		method: json(Method, { version: 1 }),
		credential: json(unknown(), { version: 1 }),
		failed: bool(),
	},
	key: ["thing"],
});

/** This Pi's device id, one row (`device` `"pi"`), made by the first sign-in that needs it. */
const Device = defineTable("providers.device", {
	version: 1,
	columns: { device: str(), id: str() },
	key: ["device"],
});

/**
 * Finished sign-ins not given to a login yet: whose (`callerKey`), its provider and method, its credential, until when it is kept.
 * Index `by_expiry`: the expired ones, dropped by the next `keep`.
 */
const SignIns = defineTable("providers.sign_ins", {
	version: 1,
	columns: {
		signIn: str(),
		owner: str(),
		provider: str(),
		method: json(Method, { version: 1 }),
		credential: json(unknown(), { version: 1 }),
		expiresAt: int(),
	},
	key: ["signIn"],
	indexes: { by_expiry: ["expiresAt"] },
});

/** How long a finished sign-in is kept for the create step that makes its login. */
const KEPT_MS = 15 * 60_000;

/**
 * No ambient credentials: a login resolves only what it stored, never the server's environment variables or files
 * (a key in the Pi's environment becomes a login of its own, made at start).
 */
const NO_AMBIENT: AuthContext = { env: async () => undefined, fileExists: async () => false };

/** Serves `LoginStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(LoginStore, (_params, self) => {
		const logins = self.table(Logins);
		const signIns = self.table(SignIns);
		const device = self.table(Device);
		const providers = self.registry(LoginProviders);
		/** Each login's turn: one `authorize` (and with it one refresh) at a time per login. */
		const turns = new Map<string, Promise<unknown>>();
		const inTurn = <T>(thing: string, fn: () => Promise<T>): Promise<T> => {
			const run = (turns.get(thing) ?? Promise.resolve()).then(fn, fn);
			const settled = run.catch(() => undefined);
			turns.set(thing, settled);
			void settled.then(() => {
				if (turns.get(thing) === settled) turns.delete(thing);
			});
			return run;
		};
		return {
			logins: self.queries(
				logins,
				{
					map: ({ thing, provider, method, credential, failed }) => ({
						thing,
						provider,
						method,
						status: credential === null || failed ? ("signInAgain" as const) : ("signedIn" as const),
					}),
					reads: ["thing", "provider", "method", "credential", "failed"],
				},
				// The key.
				{ one: ({ thing }: { thing: string }) => query(Logins).where((login) => eq(login.thing, thing)) },
			),
			keep: async ({ owner, provider, method, credential }, ctx) => {
				const signIn = crypto.randomUUID();
				const now = Date.now();
				await self.tx(async (tx) => {
					// Index `by_expiry`: what nobody claimed in time goes with the next one kept.
					tx.deleteWhere(signIns, (row) => lt(row.expiresAt, now));
					tx.put(signIns, { signIn, owner, provider, method, credential, expiresAt: now + KEPT_MS });
					return null;
				}, ctx);
				return signIn;
			},
			claim: ({ owner, signIn }, ctx) =>
				self.tx(async (tx) => {
					const found = await tx.get(signIns, { signIn });
					if (found === undefined || found.owner !== owner || found.expiresAt < Date.now()) {
						throw invalid("args", "providers: no such sign-in of yours (used or expired)");
					}
					tx.delete(signIns, { signIn });
					return { provider: found.provider, method: found.method, credential: found.credential };
				}, ctx),
			drop: ({ owner, signIn }, ctx) =>
				self.tx(async (tx) => {
					const found = await tx.get(signIns, { signIn });
					if (found?.owner === owner) tx.delete(signIns, { signIn });
					return null;
				}, ctx),
			save: ({ thing, provider, method, credential }, ctx) =>
				self.tx(async (tx) => {
					tx.put(logins, { thing, provider, method, credential, failed: false });
					return null;
				}, ctx),
			device: (_args, ctx) =>
				self.tx(async (tx) => {
					const found = await tx.get(device, { device: "pi" });
					if (found !== undefined) return found.id;
					const id = crypto.randomUUID();
					tx.put(device, { device: "pi", id });
					return id;
				}, ctx),
			remove: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(logins, { thing });
					return null;
				}, ctx),
			authorize: ({ thing }, ctx) =>
				inTurn(thing, async () => {
					const row = await self.tx((tx) => tx.get(logins, { thing }), ctx);
					if (row === undefined) throw invalid("args", `providers: no login ${thing}`);
					if (row.credential === null) throw signInAgain(thing);
					const provider = providerOf(providers, row.provider);
					const models = createModels({ credentials: credentialsOf(thing, row, ctx), authContext: NO_AMBIENT });
					models.setProvider(provider);
					let result: PiAuthResult | undefined;
					try {
						result = await models.getAuth(provider.id);
					} catch (error) {
						await self.tx(async (tx) => {
							tx.update(logins, { thing }, { failed: true });
							return null;
						}, ctx);
						throw signInAgain(thing, error);
					}
					if (result === undefined) throw signInAgain(thing);
					return authResult(result);
				}),
		};

		/**
		 * Login `thing`'s credential as pi-ai's store (one provider: the login's): `modify` runs inside the login's
		 * turn, so a refresh writes what it read.
		 */
		function credentialsOf(
			thing: string,
			row: { readonly provider: string; readonly credential: unknown },
			ctx: Context,
		): CredentialStore {
			// Only this store writes the column, always one of pi-ai's credentials (or null, refused above).
			let current = row.credential as Credential;
			return {
				read: async () => current,
				list: async () => [{ providerId: row.provider, type: current.type }],
				modify: async (_provider, fn) => {
					const next = await fn(current);
					if (next === undefined) return current;
					await self.tx(async (tx) => {
						tx.update(logins, { thing }, { credential: next, failed: false });
						return null;
					}, ctx);
					current = next;
					return next;
				},
				delete: async () => {
					throw new Error("providers: a login signs out through its store");
				},
			};
		}
	});
}

/** Provider `id` of the registry; a login of a provider no plugin offers now can sign in to nothing. */
function providerOf(providers: RegistryValue<ReadonlyMap<string, TableItem<Provider>>>, id: string): Provider {
	const found = providers.value.get(id)?.value;
	if (found === undefined)
		throw new PluginError("providers.unknown", `providers: no plugin offers the provider ${id}`);
	return found;
}

/** The error of a login that needs a sign-in again (signed out, or its refresh refused), with why when known. */
function signInAgain(thing: string, cause?: unknown): PluginError {
	const why = cause instanceof Error ? `: ${cause.message}` : "";
	return new PluginError("providers.signInAgain", `providers: login ${thing} needs a sign-in again${why}`);
}

/** pi-ai's request auth as the contract carries it: absent fields left out. */
function authResult({ auth, env, source }: PiAuthResult): AuthResult {
	return {
		auth: {
			...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			...(auth.headers === undefined ? {} : { headers: auth.headers }),
			...(auth.baseUrl === undefined ? {} : { baseUrl: auth.baseUrl }),
		},
		...(env === undefined ? {} : { env }),
		...(source === undefined ? {} : { source }),
	};
}
