// The providers plugin on the server: the providers people may sign in to (`LoginProviders`: pi-ai's built-in ones,
// and what other plugins add), the logins' store (`store.ts`), signing in (`sign-in.ts`), and the login kind
// (`serveThing`: the things plugin admits every caller and registers the kind). A new login takes the credential of a
// sign-in its maker finished; a deleted one's credential goes with it.

import {
	type Ctx,
	defineFacet,
	invalid,
	type JsonValue,
	keyedEntries,
	type P3Principal,
	type RegistryValue,
	type Self,
	type TableItem,
	type Watchable,
} from "@earendil-works/p3/v1";
import { type Api, builtinProviders, type Model, type Provider } from "@earendil-works/p3/v1/server";
import { serveThing } from "../things/serve.ts";
import { type LoginRow, LoginStore } from "./contract.server.ts";
import { type LoginInfo, LoginKind } from "./contract.ts";
import { LoginProviders } from "./login-providers.ts";
import { ownerOf } from "./logins.ts";
import { serveSignIn } from "./sign-in.ts";
import { serveStore } from "./store.ts";

/** The providers people may sign in to, by id. */
type Providers = ReadonlyMap<string, TableItem<Provider>>;

export default defineFacet((host, self) => {
	host.serve(LoginProviders, {
		compose: (table, { report }) =>
			keyedEntries(
				table,
				(offered) => Object.fromEntries(offered.map((provider) => [provider.id, provider])),
				report,
			),
	});
	self.contribute(LoginProviders, builtinProviders());
	serveStore(host);
	serveSignIn(host);
	serveThing(host, LoginKind, {
		create: async (thing, input, by, ctx) => {
			const store = await ctx.get(LoginStore, {});
			// Only its maker's own sign-in: a person's id from their page, the server's for its own logins.
			const claimed = await store.claim({ owner: ownerOf(by), signIn: signInOf(input) }, ctx);
			await store.save({ thing, ...claimed }, ctx);
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
				// pi-ai's definitions are plain data: its catalogs are JSON.
				catalog: () =>
					self.derive(
						[row, providers],
						([{ rows }, offered]) => modelsOf(rows[0], offered) as unknown as JsonValue[],
					),
				authorize: (_args: Record<never, never>, ctx: Ctx<P3Principal>) => store.authorize({ thing }, ctx),
			};
		},
	});
});

/** The sign-in id of a create step's input: wire input from the person's page, checked here. */
function signInOf(input: unknown): string {
	const signIn = typeof input === "object" && input !== null ? (input as { signIn?: unknown }).signIn : undefined;
	if (typeof signIn !== "string") throw invalid("args", "providers: a login needs a finished sign-in");
	return signIn;
}

/** A login as everyone admitted sees it, live: its row, and its provider's name and models. */
function loginOf(
	row: Watchable<{ rows: LoginRow[] }>,
	providers: RegistryValue<Providers>,
	self: Self<P3Principal>,
): Watchable<LoginInfo> {
	return self.derive([row, providers], ([{ rows }, offered]): LoginInfo => {
		const found = rows[0];
		const provider = found === undefined ? undefined : offered.get(found.provider)?.value;
		return {
			provider: found?.provider ?? "",
			providerName: provider?.name ?? found?.provider ?? "",
			method: found?.method ?? "api_key",
			status: found?.status ?? "signInAgain",
			models: modelsOf(found, offered).map(({ id, name, reasoning, contextWindow }) => ({
				id,
				name,
				reasoning,
				contextWindow,
			})),
		};
	});
}

/** The chat models of login `row`'s provider (none while no plugin offers it). */
function modelsOf(row: LoginRow | undefined, offered: Providers): readonly Model<Api>[] {
	return row === undefined ? [] : (offered.get(row.provider)?.value.getModels() ?? []);
}
