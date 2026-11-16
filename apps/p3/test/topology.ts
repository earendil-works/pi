// The test topology (`docs/workflow.md`, Tests): p3's server and its session workers as hosts in one process, linked
// in memory, each with its own store, the plugins' facets imported as modules (no build), and clients connected as the
// owner or a person. A worker starts on the first hold of its session, as the kit starts one; it is never stopped for
// idleness. A topology on a store file can be restarted: the server and its workers close and a new server opens the
// same file. A plugin whose setup fails fails the server's start, as the kit's required root does, and a worker's is
// recorded in `errors`; every host waits at most `READY` ms for an object, so a mistake fails a test in seconds.

import {
	type Address,
	createHost,
	type Host,
	type HostError,
	type LoadReport,
	memoryLinkPair,
	openStore,
	type PluginFacet,
	type Store,
	sqliteBackend,
} from "@earendil-works/chord";
import { appInfoFacet, workerInfoFacet } from "@earendil-works/chord/app";
import type { Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { type P3Principal, Server, Session } from "@p3/app/v1";
import sessionsServer from "../plugins/sessions/server.ts";
import sessionsWorker from "../plugins/sessions/worker.ts";
import { mayReachSession, PRINCIPALS } from "../src/app.ts";

/** How long a host of the topology waits for an object to go live: a failing test fails in seconds, not a minute. */
const READY = 5000;

/** The server's plugins, as the kit loads them from p3's root. */
const SERVER_PLUGINS: readonly PluginFacet<P3Principal>[] = [{ name: "@p3/sessions", facet: sessionsServer }];

/** A worker's plugins. */
const WORKER_PLUGINS: readonly PluginFacet<P3Principal>[] = [{ name: "@p3/sessions", facet: sessionsWorker }];

/** One session's worker in the topology: its host and its store. */
type Worker = { readonly host: Host<P3Principal>; readonly store: Store };

/** What went wrong in the background: a host's report, or plugins of a worker whose setup failed. */
export type TopologyError =
	| HostError
	| { readonly kind: "worker_load_failed"; readonly worker: string; readonly failed: LoadReport["failed"] };

/** A running topology. */
export interface Topology {
	/** The server's host. */
	readonly server: Host<P3Principal>;
	/** The session workers started so far, by address key (`session|<id>`). */
	readonly workers: ReadonlyMap<string, Worker>;
	/** What went wrong in the background, in order. */
	readonly errors: readonly TopologyError[];
	/** A client host connected to the server as `principal` (a page, a terminal), loaded with no plugins. */
	client(principal: P3Principal): Promise<Host<P3Principal>>;
	/** Closes the clients, the workers and the server, then opens a new server on the same store file. */
	restart(): Promise<void>;
	/** Closes everything. */
	close(): Promise<void>;
}

/** Where the server's store lives: in memory, or in a file (a restart opens it again). */
export type ServerStore = { readonly kind: "memory" } | { readonly kind: "file"; readonly path: string };

/** Starts a topology: the server, loaded, with its route to session workers. */
export async function topology(context: Context, store: ServerStore = { kind: "memory" }): Promise<Topology> {
	const made = new Running(store, context);
	await made.start();
	return made;
}

/** A store on `path` (`:memory:` for none). */
async function storeAt(path: string, context: Context): Promise<Store> {
	return openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
}

/** Throws the failures of the server's load: as the kit's required root, a failing plugin fails the start. */
function throwFailed(report: LoadReport): void {
	if (report.failed.length === 0) return;
	const names = report.failed.map(({ plugin }) => plugin).join(", ");
	throw new Error(`topology: plugins failed to load: ${names}`, { cause: report.failed[0]!.error });
}

class Running implements Topology {
	readonly #store: ServerStore;
	readonly #context: Context;
	readonly #workers = new Map<string, Worker>();
	readonly #clients: Host<P3Principal>[] = [];
	readonly #errors: TopologyError[] = [];
	#server: { readonly host: Host<P3Principal>; readonly store: Store } | undefined;

	constructor(store: ServerStore, context: Context) {
		this.#store = store;
		this.#context = context;
	}

	get server(): Host<P3Principal> {
		return this.#server!.host;
	}

	get workers(): ReadonlyMap<string, Worker> {
		return this.#workers;
	}

	get errors(): readonly TopologyError[] {
		return this.#errors;
	}

	async start(): Promise<void> {
		const context = this.#context;
		const store = await storeAt(this.#store.kind === "file" ? this.#store.path : ":memory:", context);
		const onError = (error: HostError) => this.#errors.push(error);
		const server = createHost<P3Principal>({
			address: Server(),
			principal: PRINCIPALS.server,
			store,
			readyTimeout: READY,
			onError,
		});
		this.#server = { host: server, store };
		server.route(Session, { authorize: mayReachSession, resolve: (address) => this.#worker(address) }, context);
		const appInfo = appInfoFacet({ dataDir: "", name: "p3", version: "v1", owner: PRINCIPALS.owner });
		try {
			throwFailed(await server.load([{ name: "chord.app.info", facet: appInfo }, ...SERVER_PLUGINS], context));
		} catch (error) {
			// Nobody gets the topology: what it opened closes here (the kit closes a failed start the same way).
			await this.close();
			throw error;
		}
	}

	/** Starts the worker at `address`, as the kit does: connected first, then loaded (W6); its link for the route. */
	async #worker(address: Address) {
		const context = this.#context;
		const principal = PRINCIPALS.worker(address);
		const store = await storeAt(":memory:", context);
		const onError = (error: HostError) => this.#errors.push(error);
		const host = createHost<P3Principal>({ address, principal, store, readyTimeout: READY, onError });
		this.#workers.set(address.key, { host, store });
		const [up, down] = memoryLinkPair();
		host.connect(up, { principal: PRINCIPALS.server, trusted: true }, context);
		const info = { address: { kind: address.kind, key: address.key, params: address.params }, start: {} };
		const facets = [{ name: "chord.app.worker-info", facet: workerInfoFacet<P3Principal>(info) }, ...WORKER_PLUGINS];
		// Not awaited: the route returns the link before the worker loaded (its load may wait on the server).
		void host.load(facets, context).then(
			(report) => {
				if (report.failed.length > 0) {
					this.#errors.push({ kind: "worker_load_failed", worker: address.key, failed: report.failed });
				}
			},
			(error: unknown) =>
				this.#errors.push({ kind: "worker_load_failed", worker: address.key, failed: [{ plugin: "", error }] }),
		);
		return { link: down, principal, trusted: true };
	}

	async client(principal: P3Principal): Promise<Host<P3Principal>> {
		const [toServer, fromClient] = memoryLinkPair();
		const client = createHost<P3Principal>({ readyTimeout: READY, onError: (error) => this.#errors.push(error) });
		this.server.accept(fromClient, { principal }, this.#context);
		client.connect(toServer, { principal: PRINCIPALS.server }, this.#context);
		await client.load([], this.#context);
		this.#clients.push(client);
		return client;
	}

	async restart(): Promise<void> {
		if (this.#store.kind !== "file") throw new Error("topology: a restart needs a store file");
		await this.close();
		await this.start();
	}

	async close(): Promise<void> {
		const context = this.#context;
		for (const client of this.#clients.splice(0)) await client.close(context);
		for (const [key, { host, store }] of this.#workers) {
			await host.close(context);
			await store.close(context);
			this.#workers.delete(key);
		}
		const server = this.#server;
		this.#server = undefined;
		if (server === undefined) return;
		await server.host.close(context);
		await server.store.close(context);
	}
}
