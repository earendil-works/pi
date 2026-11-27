// The providers plugin on the server: the providers people may sign in to (`LoginProviders`: pi-ai's built-in ones,
// and what other plugins add), their types' model catalogs (`LoginCatalogs`, each kept current by its type, stored in
// `catalog-store.ts`), the logins' store (`store.ts`), signing in (`sign-in.ts`), the login kind and the model
// settings kind (`serveThing`: the things plugin admits every caller and registers the kinds), and the models a
// session may use (`SessionModels`, `session-models.ts`). A new login takes the credential of a sign-in its maker
// finished; a deleted one's credential goes with it. A login's models are its type's catalog cut to its account
// (`LoginAccount`).

import {
	type Api,
	type Ctx,
	defineFacet,
	invalid,
	type Model,
	type P3Principal,
	type Self,
	type Watchable,
} from "@earendil-works/p3/v1";
import { builtinProviders } from "@earendil-works/p3/v1/server";
import { serveThing } from "../things/serve.ts";
import { serveBuiltinCatalogs } from "./builtin-catalogs.ts";
import { serveCatalogStore } from "./catalog-store.ts";
import {
	type AccountModels,
	LoginAccount,
	type LoginRow,
	LoginStore,
	ModelSettingsStore,
	SignIns,
} from "./contract.server.ts";
import type { ModelOverride } from "./contract.ts";
import { type LoginInfo, LoginKind } from "./kind.ts";
import { serveLoginAccount } from "./login-account.ts";
import { serveLoginCatalogs } from "./login-catalogs.ts";
import { LoginProviders, serveLoginProviders } from "./login-providers.ts";
import { ownerOf } from "./logins.ts";
import { serveModelSettingsStore } from "./model-settings-store.ts";
import { ModelSettingsKind } from "./models-kind.ts";
import { serveSessionModels } from "./session-models.ts";
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
	serveLoginAccount(host);
	serveSignIn(host);
	serveModelSettingsStore(host);
	serveSessionModels(host);
	serveThing(host, LoginKind, {
		implement: ({ thing }, _admitted, self) => {
			const store = self.get(LoginStore, {});
			const row = self.liveQuery(store.logins.one, { thing }, { first: 1 });
			const account = self.get(LoginAccount, { thing }).account;
			return {
				login: loginOf(row, account, self),
				authorize: (_args: Record<never, never>, ctx: Ctx<P3Principal>) => store.authorize({ thing }, ctx),
			};
		},
		create: async ({ thing, input, by }, ctx) => {
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
	serveThing(host, ModelSettingsKind, {
		implement: ({ thing }, _admitted, self) => {
			const store = self.get(ModelSettingsStore, {});
			const row = self.liveQuery(store.settings.one, { thing }, { first: 1 });
			return {
				overrides: self.derive([row], ([{ rows }]) => rows[0]?.overrides ?? []),
				set: ({ overrides }: { overrides: ModelOverride[] }, ctx: Ctx<P3Principal>) =>
					store.set({ thing, overrides }, ctx),
			};
		},
		configure: async (thing, { overrides }, ctx) => {
			// Only `overrides` is a setting; a configure without it changes nothing. The things store checked it against
			// the member's schema (item 86).
			if (overrides === undefined) return;
			await (await ctx.get(ModelSettingsStore, {})).set({ thing, overrides: overrides as ModelOverride[] }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(ModelSettingsStore, {})).clear({ thing }, ctx);
		},
	});
});

/** A login as everyone admitted sees it, live: its row, and its provider's name and its account's models. */
function loginOf(
	row: Watchable<{ rows: LoginRow[] }>,
	account: Watchable<AccountModels | null>,
	self: Self<P3Principal>,
): Watchable<LoginInfo | null> {
	return self.derive([row, account], ([{ rows }, models]): LoginInfo | null => {
		const found = rows[0];
		if (found === undefined) return null;
		return {
			provider: found.provider,
			providerName: models?.providerName ?? found.provider,
			method: found.method,
			status: found.status,
			// The account's models are pi-ai's definitions (`LoginAccount`).
			models: ((models?.models ?? []) as Model<Api>[]).map(({ id, name, reasoning, contextWindow }) => ({
				id,
				name,
				reasoning,
				contextWindow,
			})),
		};
	});
}
