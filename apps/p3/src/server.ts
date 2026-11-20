// The p3 server's bootstrap: everything that must exist before plugins can load, and nothing else. It takes the data
// directory's lock, opens the server's store, creates the host, Chord's HTTP component (`/chord`) and plugins
// component, registers the route to session workers (its `resolve` asks the `WorkerRunners` registry, its `admit` the
// sessions plugin's `SessionRoute`), serves the base's registries (`ServerRuntime`, `WorkerRunners`, `LinkOpened`), loads the
// server plugins, listens, and writes `running.json` (pid, port). Everything else is a plugin.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	allow,
	type ChordStore,
	createHost,
	defineFacet,
	deny,
	type Facet,
	type HostError,
	openStore,
	orderedEntries,
	sqliteBackend,
} from "@earendil-works/chord";
import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import { createHttp, type HttpError, HttpListener, type ListenAddress } from "@earendil-works/chord/http";
import { createPlugins, type PluginsError } from "@earendil-works/chord/plugins";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { processLock } from "@earendil-works/chord/workers/child";
import { Server, Session } from "@earendil-works/p3/v1";
import {
	LinkOpened,
	type LinkOpenedHook,
	ServerRuntime,
	SessionRoute,
	WorkerRunners,
} from "@earendil-works/p3/v1/server";
import { API, KINDS, SERVER, workerPrincipal } from "./app.ts";
import { openDataDir, privateDirectory, privateStore, writePrivate } from "./files.ts";
import { SERVER_MODULES } from "./modules-server.ts";
import type { P3Principal } from "./principals.ts";
import { type ServerRecord, serverFile, serverLock } from "./records.ts";

/** What the server's start takes. */
export type ServerOptions = {
	readonly dataDir: string;
	/** The plugin roots: p3's built-in one first (`required`: a plugin of it failing fails the start). */
	readonly roots: readonly { readonly path: string; readonly required: boolean }[];
	/** Where it listens: `127.0.0.1` and this port (0: a free one). */
	readonly port: number;
	/** How a session's worker process starts. */
	readonly worker: { readonly entry: string; readonly execArgv: readonly string[] };
	/** How long a worker idles before it stops itself: 5 minutes by default. */
	readonly workerIdleMs?: number;
	/** p3's version, for `running.json`. */
	readonly version: string;
	/** Facets of the server's own besides the base's, loaded with them (the memory test's telemetry ingest). */
	readonly facets?: readonly { readonly name: string; readonly facet: Facet<P3Principal> }[];
	/** What the owner's stop does (the command's close). */
	readonly onStop: () => void;
	readonly onError: (error: ServerError) => void;
};

/** What the server reports in the background. */
export type ServerError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "http"; readonly error: HttpError }
	| { readonly kind: "plugins"; readonly error: PluginsError };

/** A running server. */
export type RunningServer = {
	readonly dataDir: string;
	readonly port: number;
	readonly runtime: ServerRuntime;
	/** Closes everything it opened, removes `running.json` and releases the data directory's lock. */
	close(context: Context): Promise<void>;
};

/** How long a start waits for the data directory's lock before it is refused. */
const LOCK_MS = 1000;

/** How long a worker idles before it stops itself, by default. */
const IDLE_MS = 5 * 60_000;

/** Starts the server: resolves once its plugins are loaded and it listens; a failure closes what it opened. */
export async function startServer(options: ServerOptions, context: Context): Promise<RunningServer> {
	const dataDir = await openDataDir(options.dataDir);
	const lock = await processLock(serverLock(dataDir), withAbortSignal(AbortSignal.timeout(LOCK_MS), context)).catch(
		() => {
			throw new Error(`p3: another server runs on ${dataDir}`);
		},
	);
	const closers: ((context: Context) => Promise<void> | void)[] = [() => lock.release()];
	const close = async (ctx: Context): Promise<void> => {
		for (const closer of closers.reverse()) await closer(ctx);
	};
	try {
		await privateDirectory(join(dataDir, "server"));
		// Made now, so the plugin watcher watches a root nobody created yet (the user's): a plugin added later is seen.
		for (const { path } of options.roots) await mkdir(path, { recursive: true });
		const file = join(dataDir, "server", "store.sqlite");
		await privateStore(file);
		// `openStore` makes the one kind of store there is: its `settled` is the runner's, for a worker's exit.
		const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(file)), context)) as ChordStore;
		closers.push((ctx) => store.close(ctx));
		const listen = { host: "127.0.0.1", port: options.port };
		// Chord retries a listen that failed; a start does not wait for a port: its first failure ends the start.
		const unheard = Promise.withResolvers<never>();
		unheard.promise.catch(() => {});
		let starting = true;
		const host = createHost<P3Principal>({
			address: Server(),
			principal: SERVER,
			store,
			onError: (error) => {
				if (starting && error.kind === "activation_failed" && error.object === HttpListener.name) {
					unheard.reject(listenFailed(listen, error.failure.error.cause));
				} else options.onError({ kind: "host", error });
			},
		});
		closers.push((ctx) => host.close(ctx));
		// The composed hook, read at each link (a read composes the current table).
		let linkOpened: { readonly value: LinkOpenedHook } | undefined;
		const http = createHttp(
			host,
			{
				listen,
				links: {
					path: "/chord",
					opened: (request, _principal, closeLink) => linkOpened?.value(request, closeLink),
				},
				onError: (error) => options.onError({ kind: "http", error }),
			},
			context,
		);
		// Closed before the host: it drains the requests the host's close would seal.
		closers.push((ctx) => http.close(ctx));
		const plugins = createPlugins(
			{
				roots: options.roots.map(({ path, required }) => ({ path, required })),
				api: { name: API.name, versions: [...API.versions] },
				kinds: {
					server: { platform: KINDS.server.platform, hostPackages: [...KINDS.server.hostPackages] },
					worker: { platform: KINDS.worker.platform, hostPackages: [...KINDS.worker.hostPackages] },
				},
				onError: (error) => options.onError({ kind: "plugins", error }),
			},
			context,
		);
		closers.push(() => plugins.close());
		const sessions = host.route(
			Session,
			{
				// Admission decides; a worker never reaches another session's worker.
				authorize: () => true,
				admit: (principal, address, self) => {
					const route = self.get(SessionRoute, { session: address.params.id });
					return self.derive([route.exists], ([exists]) =>
						principal.kind !== "worker" && exists ? allow(null) : deny("no such session"),
					);
				},
				resolve: async (address, routing) => {
					const runner = (await host.registry(WorkerRunners, routing)).value;
					if (runner === undefined) throw new Error("p3: no runner for session workers");
					const link = await runner.start(address, routing);
					return { link, principal: workerPrincipal(address.params.id), trusted: true };
				},
			},
			context,
		);
		let listening: ListenAddress | undefined;
		const runtime: ServerRuntime = {
			dataDir,
			host,
			store,
			sessions,
			worker: options.worker,
			workerIdleMs: options.workerIdleMs ?? IDLE_MS,
			workerScripts: async (ctx) => plugins.current("worker") ?? (await plugins.scripts("worker", ctx)),
			listening: () => listening,
			apply: async (ctx) => {
				const built = await plugins.build(plugins.state.value.dirty, ctx);
				const runner = (await host.registry(WorkerRunners, ctx)).value;
				const steps = [plugins.step("server", host), ...(runner === undefined ? [] : [runner.rollout])];
				return plugins.rollout(steps, built, ctx);
			},
			stop: options.onStop,
		};
		const core = [
			{ name: "chord.http", facet: http.facet },
			{ name: "p3.server", facet: coreFacet(runtime) },
			...(options.facets ?? []),
		];
		await plugins.load(host, { kind: "server", core, modules: SERVER_MODULES }, context);
		linkOpened = await host.registry(LinkOpened, context);
		listening = await Promise.race([http.listening(context), unheard.promise]);
		starting = false;
		const record: ServerRecord = {
			pid: process.pid,
			port: listening.port,
			version: options.version,
			startedAt: Date.now(),
		};
		await writePrivate(serverFile(dataDir), JSON.stringify(record));
		closers.splice(1, 0, () => rm(serverFile(dataDir), { force: true }));
		return { dataDir, port: listening.port, runtime, close };
	} catch (error) {
		await close(context);
		throw error;
	}
}

/**
 * The base's facet: it serves `ServerRuntime` (the process values), `WorkerRunners` (the first runner by plugin name) and
 * `LinkOpened` (every hook called, in plugin order).
 */
function coreFacet(runtime: ServerRuntime): Facet<P3Principal> {
	return defineFacet<P3Principal>((host) => {
		host.serve(ServerRuntime, { compose: () => runtime });
		host.serve(WorkerRunners, { compose: (table) => table[0]?.value });
		host.serve(LinkOpened, {
			compose: (table) => {
				const hooks = orderedEntries(table, (hook) => [hook]);
				return (request, close) => {
					const ends = hooks.map(({ value }) => value(request, close)).filter((end) => end !== undefined);
					if (ends.length === 0) return undefined;
					return () => {
						for (const end of ends) end();
					};
				};
			},
		});
	});
}

/** The error of a listen on `address` that failed with `cause`: `EADDRINUSE` names the port. */
function listenFailed(address: ListenAddress, cause: unknown): Error {
	const code = (cause as NodeJS.ErrnoException | undefined)?.code;
	const why = code === "EADDRINUSE" ? "the port is in use" : cause instanceof Error ? cause.message : String(cause);
	return new Error(`p3: cannot listen on ${address.host}:${address.port}: ${why}`, { cause });
}
