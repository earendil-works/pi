// The test topology: p3's server and its session workers as hosts in one process, linked in memory, each with its
// own SQLite store, the plugins' facets imported as modules (no build), clients connected as any principal. The base's
// own pieces are the real server's and worker's (`src/server-core.ts`, `src/worker-core.ts`); the route starts a worker
// as a host here instead of a process. A plugin reloads with `reload` (a new facet object of the same setup: its
// objects restart, as after an edit), on the server or on a worker, so a test reloads a facet while it is in use.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Address,
	type ChordStore,
	createHost,
	type Facet,
	type Host,
	type HostError,
	type LoadReport,
	memoryLinkPair,
	openStore,
	sqliteBackend,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { createHttp, type HttpError } from "@earendil-works/chord/http";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { type P3Principal, Server, Session } from "@earendil-works/p3/v1";
import type { ServerRuntime } from "@earendil-works/p3/v1/server";
import type { WorkerRuntime } from "@earendil-works/p3/v1/worker";
import runnerWorker from "../plugins/runner/worker.ts";
import sessionsServer from "../plugins/sessions/server.ts";
import sessionsWorker from "../plugins/sessions/worker.ts";
import signInServer from "../plugins/sign-in/server.ts";
import { SERVER, workerPrincipal } from "../src/app.ts";
import { admitSession, serverCoreFacet } from "../src/server-core.ts";
import { workerCoreFacets } from "../src/worker-core.ts";
import probeWorker from "./plugins/probe/worker.ts";

/** How long a host of the topology waits for an object to go live: a failing test fails in seconds. */
const READY = 5000;

/** A plugin as a host loads it. */
type Plugin = { readonly name: string; readonly facet: Facet<P3Principal> };

/** The server's plugins, by name. */
const SERVER_PLUGINS: readonly Plugin[] = [
	{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
	{ name: "@earendil-works/p3-sign-in", facet: signInServer },
];

/** A worker's plugins, by name. */
const WORKER_PLUGINS: readonly Plugin[] = [
	{ name: "@earendil-works/p3-runner", facet: runnerWorker },
	{ name: "@earendil-works/p3-sessions", facet: sessionsWorker },
	{ name: "p3-test-probe", facet: probeWorker },
];

/** One session's worker in the topology. */
type Worker = { readonly host: Host<P3Principal>; readonly store: ChordStore; facets: readonly Plugin[] };

/** A running topology. */
export type Topology = {
	readonly server: Host<P3Principal>;
	/** The session workers started so far, by session id. */
	readonly workers: ReadonlyMap<string, Worker>;
	/** What the hosts reported in the background, and the workers whose `close` was called (idle). */
	readonly errors: readonly (
		| HostError
		| { readonly kind: "http"; readonly error: HttpError }
		| { readonly kind: "load_failed"; readonly failed: LoadReport["failed"] }
	)[];
	readonly closed: readonly string[];
	/** A client host connected to the server as `principal`, loaded with no plugins. */
	client(principal: P3Principal): Promise<Host<P3Principal>>;
	/** Reloads plugin `name` on the server (or on session `session`'s worker): every object of it restarts. */
	reload(name: string, session?: string): Promise<void>;
	close(): Promise<void>;
};

/** Starts a topology: the server loaded, with its route to session workers; `idleMs` is each worker's idle time. */
export async function topology(context: Context, idleMs = 60_000): Promise<Topology> {
	const dataDir = await mkdtemp(join(tmpdir(), "p3-topology-"));
	const errors: Topology["errors"][number][] = [];
	const closed: string[] = [];
	const workers = new Map<string, Worker>();
	const clients: Host<P3Principal>[] = [];
	const store = await storeAt(context);
	const server = createHost<P3Principal>({
		address: Server(),
		principal: SERVER,
		store,
		readyTimeout: READY,
		onError: (error) => errors.push(error),
	});
	const startWorker = async (address: Address<typeof Session>) => {
		const session = address.params.id;
		const workerStore = await storeAt(context);
		const host = createHost<P3Principal>({
			address,
			principal: workerPrincipal(session),
			store: workerStore,
			readyTimeout: READY,
			onError: (error) => errors.push(error),
		});
		const runtime: WorkerRuntime = {
			session,
			host,
			store: workerStore,
			dir: join(dataDir, "workers", session),
			idleMs,
			close: () => void closed.push(session),
		};
		const facets = [...workerCoreFacets(runtime), ...WORKER_PLUGINS];
		workers.set(session, { host, store: workerStore, facets });
		const [up, down] = memoryLinkPair();
		host.connect(up, { principal: SERVER, trusted: true }, context);
		// Not awaited: the route gets the link before the worker loaded (its load may wait on the server).
		void host.load(facets, context).then(
			(report) => report.failed.length > 0 && errors.push({ kind: "load_failed", failed: report.failed }),
			(error: unknown) => errors.push({ kind: "load_failed", failed: [{ plugin: session, error }] }),
		);
		return { link: down, principal: workerPrincipal(session), trusted: true as const };
	};
	const sessions = server.route(
		Session,
		{ authorize: () => true, admit: admitSession, resolve: startWorker },
		context,
	);
	const runtime: ServerRuntime = {
		dataDir,
		host: server,
		store,
		sessions,
		worker: { entry: "", execArgv: [] },
		workerIdleMs: idleMs,
		workerScripts: async () => [],
		listening: () => undefined,
		apply: () => Promise.reject(new Error("topology: no apply")),
		stop: () => {},
	};
	// Chord's HTTP component without a listener: its registries are served (the sign-in plugin contributes to them).
	const http = createHttp(server, { onError: (error) => errors.push({ kind: "http", error }) }, context);
	let serverFacets: readonly Plugin[] = [
		{ name: "chord.http", facet: http.facet },
		{ name: "p3.server", facet: serverCoreFacet(runtime) },
		...SERVER_PLUGINS,
	];
	throwFailed(await server.load(serverFacets, context));
	return {
		server,
		workers,
		errors,
		closed,
		client: async (principal) => {
			const [toServer, fromClient] = memoryLinkPair();
			const client = createHost<P3Principal>({ readyTimeout: READY, onError: (error) => errors.push(error) });
			server.accept(fromClient, { principal }, context);
			client.connect(toServer, { principal: SERVER }, context);
			await client.load([], context);
			clients.push(client);
			return client;
		},
		reload: async (name, session) => {
			// A new facet object of the same setup: the host takes it as changed code, as after an edit.
			const renewed = (facets: readonly Plugin[]) =>
				facets.map((plugin) => (plugin.name === name ? { ...plugin, facet: { ...plugin.facet } } : plugin));
			if (session === undefined) {
				serverFacets = renewed(serverFacets);
				throwFailed(await server.reload(serverFacets, context));
				return;
			}
			const worker = workers.get(session)!;
			worker.facets = renewed(worker.facets);
			throwFailed(await worker.host.reload(worker.facets, context));
		},
		close: async () => {
			for (const client of clients.splice(0)) await client.close(context);
			for (const { host, store: workerStore } of workers.values()) {
				await host.close(context);
				await workerStore.close(context);
			}
			await http.close(context);
			await server.close(context);
			await store.close(context);
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}

/** An in-memory store. */
async function storeAt(context: Context): Promise<ChordStore> {
	// `openStore` makes the one kind of store there is.
	return (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore;
}

/** Throws the failures of a load or a reload. */
function throwFailed(report: Pick<LoadReport, "failed">): void {
	if (report.failed.length === 0) return;
	const names = report.failed.map(({ plugin }) => plugin).join(", ");
	throw new Error(`topology: plugins failed to load: ${names}`, { cause: report.failed[0]!.error });
}
