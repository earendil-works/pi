// The logins' store on the server (`LoginStore`): each login's credential, keyed by the login's thing id (a login is a
// thing, made and linked through the things plugin; its credential is this plugin's), and the request auth of a
// login, refreshed here and only here. A credential is a plain row for now (sealing at rest is ERNDL-703; backups carry
// the server's store); it never leaves this store but as the request auth `authorize` answers, and a provider's error
// text, which may carry what its server answered, reaches neither a caller nor the log.

import {
	type AuthContext,
	type AuthResult,
	arr,
	bool,
	type Credential,
	type CredentialStore,
	type Ctx,
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
	str,
	type Tx,
	union,
	unknown,
	untilAborted,
} from "@earendil-works/p3/v1";
import { createModels, ModelsError } from "@earendil-works/p3/v1/server";
import { LoginStore } from "./contract.server.ts";
import { type RequestAuth, SignInMethod } from "./contract.ts";
import { LoginProviders } from "./login-providers.ts";
import { Turns } from "./turns.ts";

/**
 * Every login: its provider, how it signs in (its credential's kind), its credential (pi-ai's `Credential`), whether
 * its provider refused it, the ids of the models its account has (`null`: all of the provider's), and its generation:
 * one more at every save, so a refresh that read an older credential never overwrites a newer one.
 */
const Logins = defineTable("providers.logins", {
	version: 1,
	columns: {
		thing: str(),
		provider: str(),
		method: json(SignInMethod, { version: 1 }),
		credential: json(unknown(), { version: 1 }),
		failed: bool(),
		models: json(union([arr(str()), nul()]), { version: 1 }),
		generation: int(),
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

/** A login's row as `authorize` reads it. */
type Row = {
	readonly provider: string;
	readonly credential: unknown;
	readonly failed: boolean;
	readonly generation: number;
};

/** Serves `LoginStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(LoginStore, (_params, self) => {
		const logins = self.table(Logins);
		const device = self.table(Device);
		const providers = self.registry(LoginProviders);
		const turns = new Turns();
		/**
		 * The object's own context while it is live: what a refresh's result is written under, so a caller that went
		 * away meanwhile never loses a token its provider already rotated.
		 */
		const live = Promise.withResolvers<Ctx<P3Principal>>();
		self.onLive((ctx) => {
			live.resolve(ctx);
			return untilAborted(ctx);
		});
		const providerOf = (id: string): Provider => {
			const found = providers.value.get(id)?.value;
			if (found === undefined) throw new PluginError("providers.unknown", `providers: no plugin offers ${id}`);
			return found;
		};
		/** Marks login `thing` refused by its provider, unless a newer credential was saved meanwhile. */
		const refuse = async (thing: string, generation: number): Promise<PluginError> => {
			await self.tx(
				async (tx) => {
					if ((await tx.get(logins, { thing }))?.generation === generation)
						tx.update(logins, { thing }, { failed: true });
					return null;
				},
				await live.promise,
			);
			return needsSignIn(thing);
		};
		/**
		 * Login `thing`'s credential as pi-ai's store (one provider: the login's), inside the login's turn: a refresh
		 * writes its result only over the credential it read, under the store's own context.
		 */
		const credentialsOf = (thing: string, row: Row, provider: Provider): CredentialStore => {
			// Only this store writes the column, always one of pi-ai's credentials.
			let current = row.credential as Credential;
			return {
				read: async () => current,
				list: async () => [{ providerId: provider.id, type: current.type }],
				modify: async (_provider, fn) => {
					const next = await fn(current);
					if (next === undefined) return current;
					await self.tx(
						async (tx) => {
							if ((await tx.get(logins, { thing }))?.generation !== row.generation) return null;
							tx.update(logins, { thing }, { credential: next, models: modelsOf(provider, next) });
							return null;
						},
						await live.promise,
					);
					current = next;
					return next;
				},
				delete: async () => {
					throw new Error("providers: a login is removed through its store");
				},
			};
		};
		return {
			logins: self.queries(
				logins,
				{
					map: ({ thing, provider, method, failed, models }) => ({
						thing,
						provider,
						method,
						status: failed ? ("signInAgain" as const) : ("signedIn" as const),
						models,
					}),
					// The credential is never read for the many holders of a login.
					reads: ["thing", "provider", "method", "failed", "models"],
				},
				// The key.
				{ one: ({ thing }: { thing: string }) => query(Logins).where((login) => eq(login.thing, thing)) },
			),
			// A save or a removal while a refresh runs wins: the refresh writes only over the generation it read.
			save: ({ thing, provider: id, credential }, ctx) =>
				self.tx(async (tx) => {
					// Only this plugin's server code saves, with pi-ai's credentials.
					const saved = credential as Credential;
					const generation = ((await tx.get(logins, { thing }))?.generation ?? 0) + 1;
					const models = modelsOf(providerOf(id), saved);
					tx.put(logins, {
						thing,
						provider: id,
						method: saved.type,
						credential,
						failed: false,
						models,
						generation,
					});
					return null;
				}, ctx),
			remove: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(logins, { thing });
					return null;
				}, ctx),
			authorize: ({ thing }, ctx) =>
				turns.run(thing, async () => {
					const row = await self.tx((tx: Tx) => tx.get(logins, { thing }), ctx);
					if (row === undefined) throw invalid("args", `providers: no login ${thing}`);
					if (row.failed) throw needsSignIn(thing);
					const provider = providerOf(row.provider);
					const models = createModels({
						credentials: credentialsOf(thing, row, provider),
						authContext: NO_AMBIENT,
					});
					models.setProvider(provider);
					let result: AuthResult | undefined;
					try {
						result = await models.getAuth(provider.id);
					} catch (error) {
						// Refused by the provider (a refresh it turned down): a sign-in again; anything else may pass.
						if (error instanceof ModelsError && error.code === "oauth") throw await refuse(thing, row.generation);
						reportError(`providers: login ${thing}: its request auth failed`, nameOf(error), ctx);
						throw new PluginError("providers.authFailed", `providers: login ${thing}: its request auth failed`);
					}
					if (result === undefined) throw await refuse(thing, row.generation);
					return requestAuth(result);
				}),
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

/** The error of a login its provider refused: a fixed text, never the provider's. */
function needsSignIn(thing: string): PluginError {
	return new PluginError("providers.signInAgain", `providers: login ${thing} needs a sign-in again`);
}

/** A thrown value by its kind alone: a provider's error text may carry what its server answered, tokens among it. */
export function nameOf(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
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
