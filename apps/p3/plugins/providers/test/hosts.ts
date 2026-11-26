// What the providers plugin's tests of a whole server host load beside the things plugin's test host
// (`../../things/test/world.ts`): the faux login's server facet, the providers plugin's, and the owner's admission
// answering for `owners` (the people plugin's, stubbed).

import { constant, defineFacet, OwnerAccess, type P3Principal, type PluginFacet } from "@earendil-works/p3/v1";
import fauxServer from "../../../test/plugins/faux-login/server.ts";
import providersServer from "../server.ts";

/** The providers plugin's name, as a host loads it. */
export const PROVIDERS = "@earendil-works/p3-providers";

/** The faux login, the providers plugin, and the owner's admission: yes for the `callerKey`s in `owners`. */
export function providerFacets(owners: ReadonlySet<string>): PluginFacet<P3Principal>[] {
	return [
		{ name: "p3-test-faux-login", facet: fauxServer },
		{ name: PROVIDERS, facet: providersServer },
		{
			name: "@earendil-works/p3-people",
			facet: defineFacet((host) =>
				host.serve(OwnerAccess, ({ caller }) => ({ owner: constant(owners.has(caller)) })),
			),
		},
	];
}
