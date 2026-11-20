// p3's API v1 for plugin tests (`@earendil-works/p3/v1/testing`): Chord's `testPlugin` with p3's API, facet kinds,
// modules and principals filled in, and the base's own facet on the tested host (`ServerRuntime` and the base's
// registries on the server, `WorkerRuntime` and `WorkerBusy` on a worker), so a built-in and a third-party plugin test
// the same way and no plugin test imports p3's base. A plugin's tests live in its `test/` folder, which no build reads
// and no release ships.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChordStore, Host, PluginFacet, Registry, Store } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { testPlugin as chordTestPlugin, type TestedPlugin } from "@earendil-works/chord/plugins";
import { Server, Session } from "@earendil-works/p3/v1";
import type { ServerRuntime } from "@earendil-works/p3/v1/server";
import { API, KINDS, type P3Principal, SERVER, workerPrincipal } from "../../app.ts";
// The processes' own maps: a worker facet gets a worker's modules (never the server's), as in a real worker.
import { admitSession, SERVER_MODULES, serverCoreFacet } from "../../server.ts";
import { WORKER_MODULES, workerCoreFacets } from "../../worker.ts";

export type { TestedPlugin } from "@earendil-works/chord/plugins";

/**
 * Which facet of a plugin a test loads: its server facet, or its worker facet on session `session`'s worker. Each gets
 * the base's facet as its real host has it, with a directory of its own (a new temporary one, removed at the close):
 * the server's `ServerRuntime` (it does not listen, starts no session worker and applies nothing), or the worker's
 * `WorkerRuntime` and `WorkerBusy`, with its idle time `idleMs` (5 minutes by default) and `close`, what its
 * `WorkerRuntime.close` does (nothing by default; a real worker exits).
 */
export type TestedFacet =
	| { readonly kind: "server"; readonly stubs?: readonly PluginFacet<P3Principal>[] }
	| {
			readonly kind: "worker";
			readonly session: string;
			readonly idleMs?: number;
			readonly close?: () => void;
			readonly stubs?: readonly PluginFacet<P3Principal>[];
	  };

/**
 * Builds the plugin in `root` as production builds it and loads its facet of `facet.kind` alone, on a host with the
 * principal and address of that kind's production host (the server, or the session's worker), with the API modules
 * that process has and the base's facet; `stubs` serve what it uses of other plugins.
 */
export async function testPlugin(
	root: string,
	facet: TestedFacet,
	context: Context,
): Promise<TestedPlugin<P3Principal>> {
	const dir = await mkdtemp(join(tmpdir(), "p3-test-plugin-"));
	const host =
		facet.kind === "server"
			? { principal: SERVER, address: Server(), modules: SERVER_MODULES }
			: {
					principal: workerPrincipal(facet.session),
					address: Session({ id: facet.session }),
					modules: WORKER_MODULES,
				};
	try {
		const tested = await chordTestPlugin<P3Principal>(
			root,
			{
				kind: facet.kind,
				api: { name: API.name, versions: API.versions },
				kinds: Object.keys(KINDS),
				platform: KINDS[facet.kind].platform,
				stubs: facet.stubs ?? [],
				hostStubs: (tested, store) =>
					facet.kind === "server"
						? serverStubs(tested, store, dir, context)
						: workerStubs(facet, tested, store, dir),
				...host,
			},
			context,
		);
		return withDirectory(tested, dir);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

/** The base's facet of the server on the test's host, with a runtime whose server does not listen. */
function serverStubs(host: Host<P3Principal>, store: Store, dataDir: string, context: Context) {
	const sessions = host.route(
		Session,
		{
			authorize: () => true,
			admit: admitSession,
			resolve: () => Promise.reject(new Error("testPlugin: the plugin tier starts no session worker")),
		},
		context,
	);
	const runtime: ServerRuntime = {
		dataDir,
		host,
		// `openStore` makes the one kind of store there is.
		store: store as ChordStore,
		sessions,
		worker: { entry: "", execArgv: [] },
		workerIdleMs: IDLE_MS,
		workerScripts: async () => [],
		listening: () => undefined,
		apply: () => Promise.reject(new Error("testPlugin: the plugin tier applies nothing")),
		stop: () => {},
	};
	return [{ name: "p3.server", facet: serverCoreFacet(runtime) }];
}

/** A worker's idle time in the plugin tier, by default: a real worker's. */
const IDLE_MS = 5 * 60_000;

/** The base's facets of a worker on the test's host, as `workerCoreFacets` serves them on a real one. */
function workerStubs(
	facet: Extract<TestedFacet, { readonly kind: "worker" }>,
	host: Host<P3Principal>,
	store: Store,
	dir: string,
) {
	return workerCoreFacets({
		session: facet.session,
		host,
		// `openStore` makes the one kind of store there is.
		store: store as ChordStore,
		dir,
		idleMs: facet.idleMs ?? IDLE_MS,
		close: facet.close ?? (() => {}),
	});
}

/** `tested`, whose close also removes the test's directory `dir`. */
function withDirectory(tested: TestedPlugin<P3Principal>, dir: string): TestedPlugin<P3Principal> {
	return {
		host: tested.host,
		plugin: tested.plugin,
		errors: tested.errors,
		contributions: <C>(R: Registry<C, unknown>) => tested.contributions(R),
		unserved: () => tested.unserved(),
		root: (fn, context, options) => tested.root(fn, context, options),
		close: async (context) => {
			try {
				await tested.close(context);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	};
}
