// `startServer`: the p3 server. It opens the server's part of the data directory (its lock and at once its record,
// `starting`; the layout, the Pi's config, the cookie secret, the store), creates the server host, Chord's HTTP
// component, its plugins component over p3's built-in root and the session workers, loads the server's plugins with
// the kit's own facets (the start data, sign-ins, the owner link, the owner's stop, its identity), says `running` in its record
// once it listens and its owner link is ready, and gives its caller the running app. Right after the listen, off the
// start's path, it builds the workers' base.

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { debuglog } from "node:util";
import { createHost, type Facet, openStore, type Store, sqliteBackend } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { createHttp, HttpListener, type ListenAddress } from "@earendil-works/chord/http";
import { createPlugins } from "@earendil-works/chord/plugins";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { ProcessLock } from "@earendil-works/chord/workers";
import { Server } from "@earendil-works/p3/v1";
import { API, KINDS, NAME, PRINCIPALS } from "../app.ts";
import type { P3Principal } from "../principals.ts";
import { type App, type AppError, RunningApp } from "./app.ts";
import { openConfig, type PiConfig, writeConfig } from "./config.ts";
import { identityFacet } from "./identity.ts";
import { appInfoFacet } from "./info.ts";
import { createLayout, defaultDataDir, type Layout, openDataDir, privateStore } from "./layout.ts";
import { OwnerLink, ownerFacet, ownerTokenFile } from "./owner.ts";
import { removeRecord, takeLock, writeRecord } from "./running.ts";
import { secretFile } from "./secrets.ts";
import { sessionWorkers, type WorkerOptions } from "./session-workers.ts";
import { createSignIns, type SignInCookie, signInCookieOf } from "./sign-ins.ts";
import { stopFacet } from "./stop.ts";

/**
 * What a start cost, printed with `NODE_DEBUG=p3` (nothing is formatted without it): for the bench, until the startup
 * spans of slice 2 replace it.
 */
const debug = debuglog("p3");

/** What `startServer` takes: what the start script decides. */
export type ServerOptions = {
	/** The data directory (no environment variables): `~/.pi/p3` by default. */
	readonly dataDir?: string;
	/** p3's built-in plugins root: a plugin of it failing stops the start. */
	readonly root: string;
	/**
	 * Where the server listens: an address for this start, or the Pi's own port, the one its config keeps from its first
	 * start, which takes `firstPort` (0: a free one).
	 */
	readonly listen: ListenAddress | { readonly host: string; readonly firstPort: number };
	/** p3's version, for the server's record. */
	readonly version: string;
	/** How a session's worker starts. */
	readonly worker: WorkerOptions;
	/** What the owner's stop over HTTP does (`POST /_p3/stop`, answered first): the start script's close. */
	readonly onStop: () => void;
	/**
	 * Facets of the server's own besides the kit's, loaded with them before the root's plugins (what the kit will run
	 * itself later: the memory test passes the telemetry ingest).
	 */
	readonly facets?: readonly { readonly name: string; readonly facet: Facet<P3Principal> }[];
	readonly onError: (error: AppError) => void;
};

/** The server could not listen on `address`: `code` is the system's (`EADDRINUSE`: the port is in use). */
export class ListenFailed extends Error {
	readonly address: ListenAddress;
	readonly code: string | undefined;

	constructor(address: ListenAddress, cause: unknown) {
		const code = (cause as NodeJS.ErrnoException | undefined)?.code;
		const why = code === "EADDRINUSE" ? "the port is in use" : cause instanceof Error ? cause.message : String(cause);
		super(`startServer: cannot listen on ${address.host}:${address.port}: ${why}`, { cause });
		this.address = address;
		this.code = code;
	}
}

/**
 * Starts the p3 server: resolves once its plugins are loaded and it listens. A failing plugin of the root (or a
 * problem discovery reports there) rejects with the plugins component's `PluginError`, an address it cannot listen on
 * with `ListenFailed`, everything closed. The session workers' base is built right after the listen, from the files as
 * they are then: a worker start waits for it.
 */
export async function startServer(options: ServerOptions, context: Context): Promise<App> {
	const { layout, config, cookie, store, lock, run } = await openServer(
		resolve(options.dataDir ?? defaultDataDir()),
		context,
	);
	const { onError } = options;
	const listen = { host: options.listen.host, port: portOf(options.listen, config) };
	const signIns = createSignIns(cookie);
	// Chord tries a listen that failed again, for as long as it takes. A start does not wait for a port: the first
	// failure ends it, as the start's error.
	const unheard = Promise.withResolvers<never>();
	unheard.promise.catch(() => {});
	let starting = true;
	const host = createHost<P3Principal>({
		address: Server(),
		principal: PRINCIPALS.server,
		store,
		onError: (error) => {
			if (starting && error.kind === "activation_failed" && error.object === HttpListener.name) {
				unheard.reject(new ListenFailed(listen, error.failure.error.cause));
			} else onError({ kind: "host", error });
		},
	});
	const http = createHttp(
		host,
		{
			listen,
			links: { path: "/chord", opened: signIns.opened },
			onError: (error) => onError({ kind: "http", error }),
		},
		context,
	);
	const plugins = createPlugins(
		{
			roots: [{ path: resolve(options.root), required: true }],
			api: { name: API.name, versions: API.versions },
			kinds: Object.fromEntries(
				Object.entries(KINDS).map(([name, { platform }]) => [name, { platform, hostPackages: apiModules(name) }]),
			),
			onError: (error) => onError({ kind: "plugins", error }),
		},
		context,
	);
	const server = { host, store, plugins };
	const workers = sessionWorkers(
		options.worker,
		server,
		layout,
		(error) => onError({ kind: "workers", error }),
		context,
	);
	const link = new OwnerLink();
	// Known before the listen, so before anyone can ask the identity route.
	let ownerToken = "";
	const core = [
		{ name: "chord.http", facet: http.facet },
		{ name: "p3.info", facet: appInfoFacet({ dataDir: layout.dataDir, name: NAME, version: API.versions[0]! }) },
		{ name: "p3.sign-ins", facet: signIns.facet },
		{ name: "p3.owner", facet: ownerFacet(link) },
		{ name: "p3.stop", facet: stopFacet(options.onStop) },
		{ name: "p3.identity", facet: identityFacet({ run, pid: process.pid, pi: config.id }, () => ownerToken) },
		...(options.facets ?? []),
	];
	const app = new RunningApp({ host, http, workers, store, plugins, lock }, layout);
	try {
		const loading = performance.now();
		await plugins.load(host, { kind: "server", core, modules: API.modules }, context);
		debug("server plugins built and loaded in %d ms", Math.round(performance.now() - loading));
		ownerToken = await ownerTokenFile(layout.ownerToken, host, context);
		const listening = await Promise.race([http.listening(context), unheard.promise]);
		starting = false;
		if (!("port" in options.listen) && config.port === undefined) {
			await writeConfig(layout.config, { ...config, port: listening.port });
		}
		link.listening(listening);
		app.started(link.renew(), listening);
		// Last: a command that reads `running` asks for an owner link at once.
		const { version } = options;
		const running = {
			state: "running",
			run,
			pi: config.id,
			port: listening.port,
			version,
			startedAt: Date.now(),
		} as const;
		await writeRecord(layout.dataDir, "server", running);
	} catch (error) {
		await app.close(context);
		throw error;
	}
	// Not awaited: the server answers meanwhile. `build` never rejects; a failure after the close is dropped.
	const building = performance.now();
	void workers.build().then((built) => {
		debug("worker base built in %d ms", Math.round(performance.now() - building));
		if (built.kind === "failed" && !app.closing()) onError({ kind: "base_build", error: built.error });
	});
	return app;
}

/** The API's modules a facet of kind `kind` may import: the shared and the kind's own module of every version. */
function apiModules(kind: string): string[] {
	return API.versions.flatMap((version) => [`${API.name}/${version}`, `${API.name}/${version}/${kind}`]);
}

/** The port of this start: the one `listen` names, else the Pi's own, `firstPort` at its first start. */
function portOf(listen: ServerOptions["listen"], config: PiConfig): number {
	return "port" in listen ? listen.port : (config.port ?? listen.firstPort);
}

/** How long a second server waits for the data directory's lock before it is refused. */
const SERVER_LOCK_MS = 1000;

/**
 * The server's own part of the data directory `path`: its lock (one server per data directory), the layout made
 * private, the Pi's config, its sign-in cookie's name and secret, and the server's store; the lock released when the
 * rest fails.
 */
async function openServer(
	path: string,
	context: Context,
): Promise<{ layout: Layout; config: PiConfig; cookie: SignInCookie; store: Store; lock: ProcessLock; run: string }> {
	const dataDir = await openDataDir(path);
	const lock = await takeLock(dataDir, "server", SERVER_LOCK_MS, context);
	if (lock === undefined) throw new Error(`startServer: another server runs on ${dataDir}`);
	try {
		// Before anything else: whoever asks who runs learns at once that this process starts, and stops trusting the
		// record a crashed server left.
		const run = randomBytes(16).toString("hex");
		await writeRecord(dataDir, "server", { state: "starting", run });
		const layout = await createLayout(dataDir);
		const config = await openConfig(layout.config);
		const cookie = signInCookieOf(config.id, await secretFile(layout.cookieSecret));
		await privateStore(layout.serverStore);
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(layout.serverStore)), context);
		return { layout, config, cookie, store, lock, run };
	} catch (error) {
		await removeRecord(dataDir, "server");
		await lock.release();
		throw error;
	}
}
