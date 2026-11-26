// What the providers plugin's tests of a whole server host load beside the things plugin's test host
// (`../../things/test/world.ts`): the faux login's server facet, the providers plugin's, the owner's admission
// answering for `owners` (the people plugin's, stubbed) and the server's runtime as far as the providers plugin reads
// it (its host: the base's, stubbed).

import {
	type Context,
	constant,
	defineFacet,
	type Host,
	OwnerAccess,
	type P3Principal,
	type PluginFacet,
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import fauxServer from "../../../test/plugins/faux-login/server.ts";
import { type World, world } from "../../things/test/world.ts";
import providersServer from "../server.ts";

/** The providers plugin's name, as a host loads it. */
export const PROVIDERS = "@earendil-works/p3-providers";

/**
 * The faux login, the providers plugin, the owner's admission (yes for the `callerKey`s in `owners`) and the server's
 * runtime with the host `host` gives once the test made it.
 */
export function providerFacets(owners: ReadonlySet<string>, host: () => Host<P3Principal>): PluginFacet<P3Principal>[] {
	return [
		{ name: "p3-test-faux-login", facet: fauxServer },
		{ name: PROVIDERS, facet: providersServer },
		{
			name: "@earendil-works/p3-people",
			facet: defineFacet((facetHost) =>
				facetHost.serve(OwnerAccess, ({ caller }) => ({ owner: constant(owners.has(caller)) })),
			),
		},
		{
			name: "p3-base",
			facet: defineFacet((facetHost) =>
				facetHost.serve(ServerRuntime, {
					// The providers plugin reads the runtime's host only; it is made after this facet loads.
					compose: () =>
						({
							get host() {
								return host();
							},
						}) as unknown as ServerRuntime,
				}),
			),
		},
	];
}

/** The things plugin's test host with the providers plugin (`providerFacets`, the runtime's host this one), `more`. */
export async function providersWorld(
	context: Context,
	owners: ReadonlySet<string>,
	more: readonly PluginFacet<P3Principal>[] = [],
): Promise<World> {
	let made: World | undefined;
	// The runtime's host is read only once a request runs, after `world` answered.
	made = await world(context, [...providerFacets(owners, () => made!.host), ...more]);
	return made;
}
