// What the providers plugin's tests of a whole server host load beside the things plugin's test host
// (`../../things/test/world.ts`): the faux login's server facet, the providers plugin's and the server's runtime as far
// as the providers plugin reads it (its host and catalog base: the base's, stubbed). The owner is the things store's
// (`ownerOf`).

import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, defineFacet, type Host, type P3Principal, type PluginFacet } from "@earendil-works/p3/v1";
import { ServerRuntime, WorkerRunners } from "@earendil-works/p3/v1/server";
import fauxServer from "../../../test/plugins/faux-login/server.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import { type World, world } from "../../things/test/world.ts";
import providersServer from "../server.ts";

/** The providers plugin's name, as a host loads it. */
export const PROVIDERS = "@earendil-works/p3-providers";

/**
 * The faux login, the providers plugin and the server's runtime with the host `host` gives once the test made it, and
 * `catalogBaseUrl` (none: no catalog request leaves).
 */
export function providerFacets(host: () => Host<P3Principal>, catalogBaseUrl?: string): PluginFacet<P3Principal>[] {
	return [
		{ name: "p3-test-faux-login", facet: fauxServer },
		{ name: PROVIDERS, facet: providersServer },
		{
			name: "p3.server",
			facet: defineFacet((facetHost) => {
				// No runner: the plugin tier starts no worker, and a session's removal deletes no worker's data.
				facetHost.serve(WorkerRunners, { compose: () => undefined });
				facetHost.serve(ServerRuntime, {
					// The providers plugin reads the runtime's host and catalog base only, the sessions plugin (a session's
					// models' tests) its data directory, work root and machine; the host is made after this facet loads.
					compose: () =>
						({
							get host() {
								return host();
							},
							catalogBaseUrl,
							dataDir: tmpdir(),
							workRoot: join(tmpdir(), "p3-providers-test-work"),
							machine: { user: "test", hostname: "test" },
						}) as unknown as ServerRuntime,
				});
			}),
		},
	];
}

/**
 * The things plugin's test host with the providers plugin (`providerFacets`, the runtime's host this one, its catalogs
 * requested at `catalogBaseUrl`), `more`.
 */
export async function providersWorld(
	context: Context,
	more: readonly PluginFacet<P3Principal>[] = [],
	catalogBaseUrl?: string,
): Promise<World> {
	let made: World | undefined;
	// The runtime's host is read only once a request runs, after `world` answered.
	made = await world(context, [...providerFacets(() => made!.host, catalogBaseUrl), ...more]);
	return made;
}

/** The owner of `at`'s things store (the first start's person: who may sign in), as a principal. */
export async function ownerOf(at: World, context: Context): Promise<P3Principal> {
	const things = await at.host.get(ThingsStore, {}, context);
	const [owner] = (await things.persons.owners.page({}, 1, context)).items;
	return { kind: "person", id: owner!.person, name: owner!.name };
}
