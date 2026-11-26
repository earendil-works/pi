// The providers plugin on the server: the providers people may sign in to (`LoginProviders`: pi-ai's built-in ones,
// and what other plugins add), the logins' store (`store.ts`), signing in (`sign-in.ts`), and the login kind
// (`serveThing`: the things plugin admits every caller and registers the kind). A new login takes the credential of a
// sign-in its maker finished; a deleted one's credential goes with it.

import {
	type Ctx,
	defineFacet,
	invalid,
	type JsonValue,
	type P3Principal,
	type RegistryValue,
	type Self,
	type Watchable,
} from "@earendil-works/p3/v1";
import { builtinProviders } from "@earendil-works/p3/v1/server";
import { serveThing } from "../things/serve.ts";
import { type LoginRow, LoginStore, SignIns } from "./contract.server.ts";
import { type LoginInfo, LoginKind } from "./contract.ts";
import { LoginProviders, type ProviderMap, serveLoginProviders } from "./login-providers.ts";
import { ownerOf } from "./logins.ts";
import { serveSignIn } from "./sign-in.ts";
import { serveStore } from "./store.ts";

export default defineFacet((host, self) => {
	serveLoginProviders(host);
	self.contribute(LoginProviders, builtinProviders());
	serveStore(host);
	serveSignIn(host);
	serveThing(host, LoginKind, {
		create: async (thing, input, by, ctx) => {
			if (by.kind === "agent") throw invalid("args", "providers: a login is made by a person, never an agent");
			// Only its maker's own finished sign-in: a person's from their page, the server's for its own logins.
			const flows = await ctx.get(SignIns, { owner: ownerOf(by) });
			await flows.adopt({ attempt: attemptOf(input), thing }, ctx);
		},
		delete: async (thing, ctx) => {
			await (await ctx.get(LoginStore, {})).remove({ thing }, ctx);
		},
		implement: ({ thing }, _admitted, self) => {
			const store = self.get(LoginStore, {});
			const providers = self.registry(LoginProviders);
			const row = self.liveQuery(store.logins.one, { thing }, { first: 1 });
			return {
				login: loginOf(row, providers, self),
				// pi-ai's definitions are plain data: its catalogs are JSON. Whatever the status (shown only): a login whose
				// refresh failed is refused by `authorize` for a while, then a request tries again, which needs a model.
				catalog: () =>
					self.derive([row, providers], ([{ rows }, offered]) => {
						const found = rows[0];
						return found === undefined ? [] : (modelsOf(found, offered) as unknown as JsonValue[]);
					}),
				authorize: (_args: Record<never, never>, ctx: Ctx<P3Principal>) => store.authorize({ thing }, ctx),
			};
		},
	});
});

/** The attempt id of a create step's input: wire input from the person's page, checked here. */
function attemptOf(input: unknown): string {
	const attempt = typeof input === "object" && input !== null ? (input as { attempt?: unknown }).attempt : undefined;
	if (typeof attempt !== "string") throw invalid("args", "providers: a login needs a finished sign-in");
	return attempt;
}

/** A login as everyone admitted sees it, live: its row, and its provider's name and its account's models. */
function loginOf(
	row: Watchable<{ rows: LoginRow[] }>,
	providers: RegistryValue<ProviderMap>,
	self: Self<P3Principal>,
): Watchable<LoginInfo | null> {
	return self.derive([row, providers], ([{ rows }, offered]): LoginInfo | null => {
		const found = rows[0];
		if (found === undefined) return null;
		return {
			provider: found.provider,
			providerName: offered.get(found.provider)?.value.name ?? found.provider,
			method: found.method,
			status: found.status,
			models: modelsOf(found, offered).map(({ id, name, reasoning, contextWindow }) => ({
				id,
				name,
				reasoning,
				contextWindow,
			})),
		};
	});
}

/** The chat models of login `row`'s account at its provider (none while no plugin offers the provider). */
function modelsOf(row: LoginRow, offered: ProviderMap) {
	const all = offered.get(row.provider)?.value.getModels() ?? [];
	const { models } = row;
	return models === null ? all : all.filter(({ id }) => models.includes(id));
}
