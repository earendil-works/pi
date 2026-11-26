// The logins' store on the server (`LoginStore`): each login's credential, keyed by the login's thing id (a login is a
// thing, made and linked through the things plugin; its credential is this plugin's), and the request auth of a
// login, refreshed here and only here. A credential is a plain row for now (sealing at rest is ERNDL-703; backups carry
// the server's store); it never leaves this store but as the request auth `authorize` answers, and a provider's error
// text, which may carry what its server answered, reaches neither a caller nor the log.
//
// A refresh may rotate the refresh token: the provider then refuses the old one. So one refresh at a time per login,
// across the store's objects too (a lease in its row: after a reload the next object waits for the one before), each
// written only over the credential it read (its row's version, new at every write) and under a context that outlives
// both its caller and the store's object, so a token the provider rotated is never lost. The lease is the server
// process's (one at a time has the store) and runs out only with its refresh: a refresh still running (its provider
// may ignore the abort pi-ai gives it) never has its token sent a second time; a request waiting for it gives up after
// a while instead. A lease of a process that is gone (a restart) holds nothing; so a release that could not be
// written (the store closing) holds its login until the next start.

import {
	type AuthContext,
	type AuthResult,
	arr,
	BACKGROUND_CONTEXT,
	type Context,
	type Credential,
	type CredentialStore,
	defineTable,
	eq,
	type FacetHost,
	int,
	invalid,
	json,
	nul,
	type P3Principal,
	PluginError,
	type Provider,
	query,
	reportError,
	sleep,
	str,
	type Tx,
	union,
	unknown,
} from "@earendil-works/p3/v1";
import { createModels, ModelsError, ServerRuntime } from "@earendil-works/p3/v1/server";
import { type LoginChange, LoginStore } from "./contract.server.ts";
import { type RequestAuth, SignInMethod } from "./contract.ts";
import { LoginProviders } from "./login-providers.ts";
import { Turns } from "./turns.ts";

/**
 * Every login: its provider, how it signs in (its credential's kind), its credential (pi-ai's `Credential`), when its
 * last refresh failed (0: it did not), the ids of the models its account has (`null`: all of the provider's), its
 * version (a new random one at every write of the credential: a refresh that read an older one writes nothing), and
 * which server process holds it for a refresh (`""`: none).
 */
const Logins = defineTable("providers.logins", {
	version: 1,
	columns: {
		thing: str(),
		provider: str(),
		method: json(SignInMethod, { version: 1 }),
		credential: json(unknown(), { version: 1 }),
		failedAt: int(),
		models: json(union([arr(str()), nul()]), { version: 1 }),
		version: str(),
		holder: str(),
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
 * No ambient credentials: a login resolves only what it stored, never the server's environment variables or files
 * (the Pi's own keys become logins of their own).
 */
const NO_AMBIENT: AuthContext = { env: async () => undefined, fileExists: async () => false };

/**
 * How long a login whose refresh failed is refused at once before one request tries again: pi-ai reports a refusal
 * and a network failure alike, and nothing signs a login in again yet.
 */
const RETRY_AFTER_MS = 2 * 60_000;

/**
 * How long a request waits for a refresh this process runs (pi-ai's refresh times out after 15 s, unless its provider
 * ignores the abort) before it fails, on the monotonic clock; and how often it looks.
 */
const WAIT_MS = 60_000;
const POLL_MS = 50;

/** A lease released: nobody holds the login. */
const RELEASED = { holder: "" } as const;

/** What a request learned of its refresh: whether it failed (or was refused at once, after a failed one). */
type Refresh = { failed: boolean };

/** Serves `LoginStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(LoginStore, (_params, self) => {
		const logins = self.table(Logins);
		const device = self.table(Device);
		const providers = self.registry(LoginProviders);
		const turns = new Turns();
		const read = (thing: string, context: Context) => self.tx((tx: Tx) => tx.get(logins, { thing }), context);
		const providerOf = (id: string): Provider => {
			const found = providers.value.get(id)?.value;
			if (found === undefined) throw new PluginError("providers.unknown", `providers: no plugin offers ${id}`);
			return found;
		};
		const runtime = self.registry(ServerRuntime);
		// This server process: its id and its start; a process id alone comes back after a restart.
		const me = `${process.pid}@${performance.timeOrigin}`;
		/** Changes login `thing` while its credential is still of `version`. */
		const settle = (thing: string, version: string, change: LoginChange, context: Context) =>
			self.tx(async (tx) => {
				if ((await tx.get(logins, { thing }))?.version === version) tx.update(logins, { thing }, change);
				return null;
			}, context);
		/**
		 * `settle` under a context nothing ends (neither the request's caller nor this object's routine). A refresh that
		 * outlived this object (a reload stopped waiting for it after its drain bound, 5 s, while a refresh may take 15)
		 * has its successor write it: the token its provider rotated is never lost.
		 */
		const ifStill = async (thing: string, version: string, change: LoginChange) => {
			try {
				await settle(thing, version, change, BACKGROUND_CONTEXT);
			} catch {
				await runtime.value.host.root(async (ctx) => {
					await (await ctx.get(LoginStore, {})).settle({ thing, version, change }, ctx);
				}, BACKGROUND_CONTEXT);
			}
		};
		/**
		 * Holds login `thing` for a refresh: waits while another request of this process holds it (one of the store's
		 * previous object, after a reload), then takes it; `gone` once the login is, `cooling` while the last refresh
		 * failed a moment ago (the one this request waited for, perhaps), `busy` when the one it waited for still runs.
		 */
		const lease = async (thing: string, context: Context) => {
			const until = performance.now() + WAIT_MS;
			for (;;) {
				const leased = await self.tx(async (tx) => {
					const row = await tx.get(logins, { thing });
					if (row === undefined) return { kind: "gone" } as const;
					if (cooling(row.failedAt)) return { kind: "cooling" } as const;
					if (row.holder === me) return { kind: "held" } as const;
					tx.update(logins, { thing }, { holder: me });
					return { kind: "leased", row } as const;
				}, context);
				if (leased.kind !== "held") return leased;
				if (performance.now() >= until) return { kind: "busy" } as const;
				await sleep(POLL_MS, context);
			}
		};
		/** Login `thing`'s credential as pi-ai's store (one provider: the login's), read fresh at every use. */
		const credentialsOf = (
			thing: string,
			provider: Provider,
			refresh: Refresh,
			context: Context,
		): CredentialStore => ({
			// Only this store writes the column, always one of pi-ai's credentials.
			read: async () => (await read(thing, context))?.credential as Credential | undefined,
			list: async () => {
				const row = await read(thing, context);
				return row === undefined ? [] : [{ providerId: provider.id, type: (row.credential as Credential).type }];
			},
			modify: async (_provider, fn) => {
				const leased = await lease(thing, context);
				if (leased.kind === "gone") return undefined;
				if (leased.kind === "cooling") {
					refresh.failed = true;
					throw new Error("providers: the last refresh failed a moment ago");
				}
				// Not a failed refresh: the request fails (`authFailed`), the login stays as it is.
				if (leased.kind === "busy") throw new Error("providers: a refresh of this login still runs");
				const { row } = leased;
				const current = row.credential as Credential;
				let next: Credential | undefined;
				try {
					next = await fn(current);
				} catch (error) {
					refresh.failed = true;
					// With the lease's release: a request waiting for this refresh is refused at once too.
					await ifStill(thing, row.version, { ...RELEASED, failedAt: Date.now() });
					throw error;
				}
				if (next === undefined) {
					await ifStill(thing, row.version, RELEASED);
					return current;
				}
				await ifStill(thing, row.version, {
					...RELEASED,
					credential: next,
					models: rotatedModels(thing, provider, row.models, next, context),
					version: crypto.randomUUID(),
					failedAt: 0,
				});
				return next;
			},
			delete: async () => {
				throw new Error("providers: a login is removed through its store");
			},
		});
		/** Stores login `thing`'s credential: `create` a new one, else replace one of the same provider. */
		const store = (kind: "create" | "replace", thing: string, id: string, credential: unknown, ctx: Context) =>
			self.tx(async (tx) => {
				const found = await tx.get(logins, { thing });
				if (kind === "create" ? found !== undefined : found?.provider !== id) {
					throw invalid("args", `providers: login ${thing} cannot take this credential (${kind})`);
				}
				// Only this plugin's server code stores credentials, pi-ai's.
				const saved = credential as Credential;
				tx.put(logins, {
					thing,
					provider: id,
					method: saved.type,
					credential,
					failedAt: 0,
					models: modelsOf(providerOf(id), saved),
					version: crypto.randomUUID(),
					...RELEASED,
				});
				return null;
			}, ctx);
		return {
			logins: self.queries(
				logins,
				{
					map: ({ thing, provider, method, failedAt, models }) => ({
						thing,
						provider,
						method,
						status: failedAt > 0 ? ("signInAgain" as const) : ("signedIn" as const),
						models,
					}),
					// The credential is never read for the many holders of a login.
					reads: ["thing", "provider", "method", "failedAt", "models"],
				},
				// The key.
				{ one: ({ thing }: { thing: string }) => query(Logins).where((login) => eq(login.thing, thing)) },
			),
			create: ({ thing, provider, credential }, ctx) => store("create", thing, provider, credential, ctx),
			replace: ({ thing, provider, credential }, ctx) => store("replace", thing, provider, credential, ctx),
			remove: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(logins, { thing });
					return null;
				}, ctx),
			authorize: ({ thing }, ctx) =>
				turns.run(thing, async () => {
					const row = await read(thing, ctx);
					if (row === undefined) throw invalid("args", `providers: no login ${thing}`);
					if (cooling(row.failedAt)) throw needsSignIn(thing);
					const provider = providerOf(row.provider);
					const refresh: Refresh = { failed: false };
					const models = createModels({
						credentials: credentialsOf(thing, provider, refresh, ctx),
						authContext: NO_AMBIENT,
					});
					models.setProvider(provider);
					let result: AuthResult | undefined;
					try {
						result = await models.getAuth(provider.id);
					} catch (error) {
						reportError(`providers: login ${thing}: its request auth failed`, nameOf(error), ctx);
						// A refresh that failed (refused, or the network): refused for a while, then tried again.
						if (refresh.failed) throw needsSignIn(thing);
						throw new PluginError("providers.authFailed", `providers: login ${thing}: its request auth failed`);
					}
					if (result === undefined) {
						await ifStill(thing, row.version, { failedAt: Date.now() });
						throw needsSignIn(thing);
					}
					// Signed in again without a refresh (a refresh wrote a new version, its own clearing).
					if (row.failedAt > 0) await settle(thing, row.version, { failedAt: 0 }, ctx);
					return requestAuth(result);
				}),
			settle: async ({ thing, version, change }, ctx) => settle(thing, version, change, ctx),
			device: (_args, ctx) =>
				self.tx(async (tx) => {
					const found = await tx.get(device, { device: "pi" });
					if (found !== undefined) return found.id;
					const id = crypto.randomUUID();
					tx.put(device, { device: "pi", id });
					return id;
				}, ctx),
		};
	});
}

/** The ids of the models `credential`'s account has at `provider` (`null`: the provider says all of its). */
function modelsOf(provider: Provider, credential: Credential): string[] | null {
	return provider.filterModels === undefined
		? null
		: provider.filterModels(provider.getModels(), credential).map(({ id }) => id);
}

/**
 * The models of login `thing`'s account after a rotation; the ones known before when its provider cannot tell them:
 * the rotated token is written whatever happens, as the provider refuses the one before it.
 */
function rotatedModels(
	thing: string,
	provider: Provider,
	known: string[] | null,
	next: Credential,
	context: Context,
): string[] | null {
	try {
		return modelsOf(provider, next);
	} catch {
		// Nothing of the thrown value: a provider's (its name, its text) may carry anything, or throw itself.
		reportError(`providers: login ${thing}: its models`, "its provider could not tell them", context);
		return known;
	}
}

/** Whether a refresh failed (at `failedAt`, 0: none did) a moment ago: its login is refused at once. */
function cooling(failedAt: number): boolean {
	return failedAt > 0 && Date.now() - failedAt < RETRY_AFTER_MS;
}

/** The error of a login that needs a sign-in again: a fixed text, never the provider's. */
function needsSignIn(thing: string): PluginError {
	return new PluginError("providers.signInAgain", `providers: login ${thing} needs a sign-in again`);
}

/** pi-ai's `ModelsError` codes: fixed texts, the only part of a thrown value that is logged. */
const CODES: ReadonlySet<unknown> = new Set([
	"model_source",
	"model_validation",
	"provider",
	"stream",
	"auth",
	"oauth",
]);

/**
 * A thrown value as the log may name it: pi-ai's `ModelsError` by its code, anything else as an error. A provider's
 * error (its name, its text) may carry what its server answered, tokens among it, and its fields may throw.
 */
export function nameOf(error: unknown): string {
	try {
		if (error instanceof ModelsError && CODES.has(error.code)) return `ModelsError(${error.code})`;
	} catch {
		// A provider's value whose field throws: named as any other.
	}
	return "an error";
}

/** pi-ai's request auth as the contract carries it: absent fields left out. */
function requestAuth({ auth, env, source }: AuthResult): RequestAuth {
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
