// p3's API v1 for plugin tests (`@earendil-works/p3/v1/testing`): Chord's `testPlugin` with p3's API, facet kinds,
// modules and principals filled in, so a built-in and a third-party plugin test the same way and no plugin test
// imports p3's base. A plugin's tests live in its `test/` folder, which no build reads and no release ships.

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChordStore, Host, PluginFacet, Store } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { testPlugin as chordTestPlugin, type TestedPlugin } from "@earendil-works/chord/plugins";
import { Server, Session } from "@earendil-works/p3/v1";
import { API, KINDS, type P3Principal, SERVER, workerPrincipal } from "../../app.ts";
// The processes' own maps: a worker facet gets a worker's modules (never the server's), as in a real worker.
import { SERVER_MODULES } from "../../server.ts";
import { WORKER_MODULES, workerCoreFacets } from "../../worker.ts";

export type { TestedPlugin } from "@earendil-works/chord/plugins";

/**
 * Which facet of a plugin a test loads: its server facet, or its worker facet on session `session`'s worker. A worker
 * gets the base's `WorkerRuntime` and `WorkerBusy` as a real one does: its idle time `idleMs` (5 minutes by default),
 * and `close`, what its `WorkerRuntime.close` does (nothing by default; a real worker exits).
 */
export type TestedFacet =
	| { readonly kind: "server"; readonly stubs?: readonly PluginFacet<P3Principal>[] }
	| {
			readonly kind: "worker";
			readonly session: string;
			readonly idleMs?: number;
			readonly close?: (reason: "idle") => void;
			readonly stubs?: readonly PluginFacet<P3Principal>[];
	  };

/**
 * Builds the plugin in `root` as production builds it and loads its facet of `facet.kind` alone, on a host with the
 * principal and address of that kind's production host (the server, or the session's worker), with the API modules
 * that process has; `stubs` serve what it uses of other plugins.
 */
export function testPlugin(root: string, facet: TestedFacet, context: Context): Promise<TestedPlugin<P3Principal>> {
	const host =
		facet.kind === "server"
			? { principal: SERVER, address: Server(), modules: SERVER_MODULES }
			: {
					principal: workerPrincipal(facet.session),
					address: Session({ id: facet.session }),
					modules: WORKER_MODULES,
				};
	return chordTestPlugin<P3Principal>(
		root,
		{
			kind: facet.kind,
			api: { name: API.name, versions: API.versions },
			kinds: Object.keys(KINDS),
			platform: KINDS[facet.kind].platform,
			stubs: facet.stubs ?? [],
			...(facet.kind === "worker" ? { hostStubs: workerStubs(facet) } : {}),
			...host,
		},
		context,
	);
}

/** The base's facets of a worker on the test's host, as `workerCoreFacets` serves them on a real one. */
function workerStubs(facet: Extract<TestedFacet, { readonly kind: "worker" }>) {
	return (host: Host<P3Principal>, store: Store) =>
		workerCoreFacets({
			session: facet.session,
			host,
			// `openStore` makes the one kind of store there is.
			store: store as ChordStore,
			dir: join(tmpdir(), `p3-test-worker-${facet.session}`),
			idleMs: facet.idleMs ?? 5 * 60_000,
			close: facet.close ?? (() => {}),
		});
}
