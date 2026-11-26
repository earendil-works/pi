// The providers people may sign in to, a registry on the server (their sign-in and auth) and on a session's worker
// (their requests): the providers plugin contributes pi-ai's built-in providers on the server, any plugin more (a
// test's faux one). `/v1` re-exports the registry, for plugins of other roots.

import {
	defineRegistry,
	type FacetHost,
	keyedEntries,
	type P3Principal,
	type Provider,
	type TableItem,
} from "@earendil-works/p3/v1";

/** The providers, by provider id, each with its plugin. */
export type ProviderMap = ReadonlyMap<string, TableItem<Provider>>;

/**
 * The providers, by provider id: a plugin contributes a list; an id contributed twice is reported, the first by
 * plugin name kept. A plugin contributing a provider under a built-in id takes the requests of that provider's logins
 * on the workers it is loaded on, their auth included: install only plugins you trust (a plugin's server code is
 * trusted anyway).
 */
export const LoginProviders = defineRegistry<readonly Provider[], ProviderMap>("providers.providers", { version: 1 });

/** Serves `LoginProviders` on `host` (the providers plugin, on the server and on a worker). */
export function serveLoginProviders(host: FacetHost<P3Principal>): void {
	host.serve(LoginProviders, {
		compose: (table, { report }) =>
			keyedEntries(
				table,
				(offered) => Object.fromEntries(offered.map((provider) => [provider.id, provider])),
				report,
			),
	});
}
