// The test topology: p3's server and its session workers as hosts in one process, linked in memory, each with its
// own SQLite store, the plugins' facets imported as modules (no build). The base's pieces are the real ones
// (`serverCoreFacet`, `admitRoute`, `workerCoreFacet`); the route starts a worker as a host, not a process, and the
// runner it contributes is asked by the waker alone. `reload` renews a plugin's facet object on the server or a
// worker (its objects restart, as after an edit); `count` reads the server's metrics.

import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
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
import { PeopleStore, type ServerRuntime } from "@earendil-works/p3/v1/server";
import type { WorkerRuntime } from "@earendil-works/p3/v1/worker";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import controlServer from "../plugins/control/server.ts";
import environmentsServer from "../plugins/environments/server.ts";
import environmentsWorker from "../plugins/environments/worker.ts";
import peopleServer from "../plugins/people/server.ts";
import runnerServer from "../plugins/runner/server.ts";
import runnerWorker from "../plugins/runner/worker.ts";
import sessionsServer from "../plugins/sessions/server.ts";
import sessionsWorker from "../plugins/sessions/worker.ts";
import signInServer from "../plugins/sign-in/server.ts";
import thingsServer from "../plugins/things/server.ts";
import thingsWorker from "../plugins/things/worker.ts";
import { SERVER, workerPrincipal } from "../src/app.ts";
import { admitRoute, serverCoreFacet } from "../src/server.ts";
import { workerCoreFacet } from "../src/worker.ts";
import probeWorker from "./plugins/probe/worker.ts";

/** How long a host of the topology waits for an object to go live: a failing test fails in seconds. */
const READY = 5000;

/** A plugin as a host loads it. */
type Plugin = { readonly name: string; readonly facet: Facet<P3Principal> };

/** The server's plugins, by name. */
const SERVER_PLUGINS: readonly Plugin[] = [
	{ name: "@earendil-works/p3-control", facet: controlServer },
	{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	{ name: "@earendil-works/p3-people", facet: peopleServer },
	{ name: "@earendil-works/p3-runner", facet: runnerServer },
	{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
	{ name: "@earendil-works/p3-sign-in", facet: signInServer },
	// The things plugin: it serves the registry the people plugin hands its owner to (ERNDL-1144's bridge).
	{ name: "@earendil-works/p3-things", facet: thingsServer },
];

/** A worker's plugins, by name. */
const WORKER_PLUGINS: readonly Plugin[] = [
	{ name: "@earendil-works/p3-environments", facet: environmentsWorker },
	{ name: "@earendil-works/p3-runner", facet: runnerWorker },
	{ name: "@earendil-works/p3-sessions", facet: sessionsWorker },
	{ name: "@earendil-works/p3-things", facet: thingsWorker },
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
	/** The owner's person (the people plugin made it at the start), as a principal. */
	readonly owner: P3Principal;
	/** The sum of the server's metric `name` so far (`chord.query.runs`, `chord.query.probes`, ...). */
	count(name: string): number;
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
	const telemetry = new InMemoryTelemetryContext();
	const server = createHost<P3Principal>({
		address: Server(),
		principal: SERVER,
		store,
		telemetry,
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
		const facets = [{ name: "p3.worker", facet: workerCoreFacet(runtime) }, ...WORKER_PLUGINS];
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
	const sessions = server.route(Session, { authorize: () => true, admit: admitRoute, resolve: startWorker }, context);
	const runtime: ServerRuntime = {
		dataDir,
		machine: { user: userInfo().username, hostname: hostname() },
		host: server,
		store,
		sessions,
		worker: { entry: "", execArgv: [] },
		workerIdleMs: idleMs,
		// No catalog request leaves a test.
		catalogBaseUrl: undefined,
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
	const [found] = (
		await server.root(async (ctx) => (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx), context)
	).items;
	return {
		owner: { kind: "person", id: found!.id, name: found!.name },
		server,
		workers,
		errors,
		closed,
		count: (name) =>
			telemetry
				.getMetrics()
				.filter((metric) => metric.name === name)
				.reduce((sum, metric) => sum + metric.value, 0),
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
	return await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
}

/** Throws the failures of a load or a reload. */
function throwFailed(report: Pick<LoadReport, "failed">): void {
	if (report.failed.length === 0) return;
	const names = report.failed.map(({ plugin }) => plugin).join(", ");
	throw new Error(`topology: plugins failed to load: ${names}`, { cause: report.failed[0]!.error });
}
