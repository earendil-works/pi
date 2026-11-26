// The providers plugin on the server: the providers people may sign in to (`LoginProviders`: pi-ai's built-in ones,
// and what other plugins add), their types' model catalogs (`LoginCatalogs`, each kept current by its type, stored in
// `catalog-store.ts`), the logins' store (`store.ts`), signing in (`sign-in.ts`), and the login kind (`serveThing`:
// the things plugin admits every caller and registers the kind). A new login takes the credential of a sign-in its
// maker finished; a deleted one's credential goes with it. A login's models are its type's catalog cut to its account.

import {
	type Api,
	type Ctx,
	defineFacet,
	invalid,
	type JsonValue,
	type Model,
	type P3Principal,
	type RegistryValue,
	type Self,
	type Watchable,
} from "@earendil-works/p3/v1";
import { builtinProviders } from "@earendil-works/p3/v1/server";
import { serveThing } from "../things/serve.ts";
import { serveBuiltinCatalogs } from "./builtin-catalogs.ts";
import { typeModels } from "./catalog.ts";
import { serveCatalogStore } from "./catalog-store.ts";
import { CatalogStore, type LoginRow, LoginStore, SignIns } from "./contract.server.ts";
import { type LoginInfo, LoginKind } from "./kind.ts";
import { serveLoginCatalogs } from "./login-catalogs.ts";
import { LoginProviders, type ProviderMap, serveLoginProviders } from "./login-providers.ts";
import { ownerOf } from "./logins.ts";
import { serveSignIn } from "./sign-in.ts";
import { serveStore } from "./store.ts";

export default defineFacet((host, self) => {
	serveLoginProviders(host);
	const builtins = builtinProviders();
	self.contribute(LoginProviders, builtins);
	serveCatalogStore(host);
	serveLoginCatalogs(host);
	serveBuiltinCatalogs(host, builtins);
	serveStore(host);
	serveSignIn(host);
	serveThing(host, LoginKind, {
		implement: ({ thing }, _admitted, self) => {
			const store = self.get(LoginStore, {});
			const providers = self.registry(LoginProviders);
			const row = self.liveQuery(store.logins.one, { thing }, { first: 1 });
			// Its type's stored catalog (none to read while its row is not there).
			const provider = self.derive([row], ([{ rows }]) => ({ provider: rows[0]?.provider ?? "" }));
			const catalog = self.liveQuery(self.get(CatalogStore, {}).catalogs.one, provider, { first: 1 });
			// The chat models of its account: its type's catalog cut to the ids the account has; none while no plugin
			// offers the provider. Computed once for `login` and `catalog`. pi-ai's definitions are plain data: JSON.
			const models = self.derive([row, providers, catalog], ([{ rows }, offered, entries]) => {
				const found = rows[0];
				const type = found === undefined ? undefined : offered.get(found.provider)?.value;
				if (found === undefined || type === undefined) return [];
				const all = typeModels(type, entries.rows[0]?.entry);
				const { models: has } = found;
				return (has === null ? all : all.filter(({ id }) => has.includes(id))) as unknown as JsonValue[];
			});
			return {
				login: loginOf(row, providers, models, self),
				// Whatever the status (shown only): a login whose refresh failed is refused by `authorize` for a while, then
				// a request tries again, which needs a model.
				catalog: () => models,
				authorize: (_args: Record<never, never>, ctx: Ctx<P3Principal>) => store.authorize({ thing }, ctx),
			};
		},
		create: async (thing, input, by, ctx) => {
			// The only guard of `makers: "people"` until the workspaces enforce makers (slice 2).
			if (by.kind === "agent") throw invalid("args", "providers: a login is made by a person, never an agent");
			// Only its maker's own finished sign-in: a person's from their page, the server's for its own logins.
			const flows = await ctx.get(SignIns, { owner: ownerOf(by) });
			await flows.adopt({ attempt: input.attempt, thing }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(LoginStore, {})).remove({ thing }, ctx);
		},
	});
});

/** A login as everyone admitted sees it, live: its row, its provider's name and its account's `models`. */
function loginOf(
	row: Watchable<{ rows: LoginRow[] }>,
	providers: RegistryValue<ProviderMap>,
	models: Watchable<JsonValue[]>,
	self: Self<P3Principal>,
): Watchable<LoginInfo | null> {
	return self.derive([row, providers, models], ([{ rows }, offered, account]): LoginInfo | null => {
		const found = rows[0];
		if (found === undefined) return null;
		return {
			provider: found.provider,
			providerName: offered.get(found.provider)?.value.name ?? found.provider,
			method: found.method,
			status: found.status,
			// The account's models are pi-ai's definitions (`models` above).
			models: (account as unknown as Model<Api>[]).map(({ id, name, reasoning, contextWindow }) => ({
				id,
				name,
				reasoning,
				contextWindow,
			})),
		};
	});
}
