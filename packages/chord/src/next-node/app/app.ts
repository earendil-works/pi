// `startApp` (slice 13 §1, §5; decisions "The app kit, point 1" to "point 5"): the server of an app built with the kit.
// It lays out the data directory, opens the server's store, creates the server host, the HTTP component and one
// workers component per worker kind, the plugins component over the app's required root and the user's root, loads
// the server's plugins with the kit's own facets (the start-data object, sessions, the owner link, pairing, files),
// and gives the app the controls it needs: the owner link, `applyChanges`, installs, export and import per address.

import { join, resolve } from "node:path";
import { type Context, withAbortSignal } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import { type Address, type HostKind, hostKind, type KindShape } from "../../next/contracts/index.ts";
import type { Principal } from "../../next/data/index.ts";
import { createHost, type Host, type HostError, type PluginFacet } from "../../next/host/index.ts";
import { openStore, type Store, sqliteBackend } from "../../next/store/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import type { Watchable } from "../../watch.ts";
import { createHttp, type HttpComponent, type HttpError, type ListenAddress } from "../http/index.ts";
import {
	createPlugins,
	type HostPackages,
	type InstallOptions,
	type PluginSource,
	type Plugins,
	type PluginsError,
	type PluginsState,
	type RolloutResult,
} from "../plugins/index.ts";
import { createWorkers, type ProcessLock, processLock, type Workers, type WorkersError } from "../workers/index.ts";
import { ARCHIVE_FORMAT, type ArchiveManifest, packAddress, unpackAddress } from "./archive.ts";
import { type FilesCaps, filesFacet } from "./files.ts";
import { appInfoFacet } from "./info.ts";
import { type AppLayout, createLayout, defaultDataDir, openDataDir, privateStore, workerDirectory } from "./layout.ts";
import { OWNER_PATH, OwnerLink, type OwnerPrincipal, ownerFacet, ownerTokenFile } from "./owner.ts";
import { Pairings, pairingFacet } from "./pairing.ts";
import { secretFile } from "./secrets.ts";
import { sessionsFacet } from "./sessions.ts";

/** The server's host kind: the kit's server host is `Server()`. */
export const Server = hostKind("server");

/**
 * The app's API (slice 12): its package name, the versions it provides (newest first) and this process's modules of
 * them by specifier (`@acme/app/v3`, `@acme/app/v3/server`).
 */
export type AppApi = {
	readonly name: string;
	readonly versions: readonly string[];
	readonly modules: HostPackages;
};

/**
 * A facet kind of the app: where its builds run, and the packages besides the API its plugins share (`react`). Its API
 * modules are named by convention: `<api>/<version>` and `<api>/<version>/<kind>` for every version.
 */
export type AppKind = { readonly platform: "node" | "browser"; readonly packages?: HostPackages };

/** A worker kind: a host kind of the app and how its workers start (the workers component's options). */
export type AppWorkerKind<P extends Principal> = {
	/** The host kind (`hostKind("project", { id: str() })`). */
	readonly kind: KindShape;
	/** The worker's entry module (it calls `startWorker`), its Node flags and environment. */
	readonly entry: string;
	readonly execArgv?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** The facet kind its workers load: `worker` by default. */
	readonly facet?: string;
	/** The app's start data for the worker at `address` (JSON), before each start. */
	readonly start: (address: Address, context: Context) => Promise<JsonValue> | JsonValue;
	/** Whether `principal` may reach the worker at `address` (synchronous). */
	readonly authorize: (principal: P, address: Address) => boolean;
	/** How long a worker idles before it stops: 5 minutes by default. */
	readonly idleMs?: () => number;
};

/** What the kit reports: from its host, its HTTP component, its workers or its plugins. */
export type AppError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "http"; readonly error: HttpError }
	| { readonly kind: "workers"; readonly error: WorkersError }
	| { readonly kind: "plugins"; readonly error: PluginsError };

/** What `startApp` takes. `{ kind: "owner" }` must be one of the app's principals (the kit's owner). */
export type AppOptions<P extends Principal> = {
	/** The app's name: its default data directory is `~/.<name>`, its archives carry it. */
	readonly name: string;
	/** The data directory (the start script's to decide; no environment variables): `~/.<name>` by default. */
	readonly dataDir?: string;
	/** The app's built-in plugins root (required): `plugins/` of the working directory by default. */
	readonly root?: string;
	/** Where the server listens: `127.0.0.1`, a free port by default. */
	readonly listen?: ListenAddress;
	readonly api: AppApi;
	/** The app's facet kinds: `server` and each worker kind's facet kind among them. */
	readonly kinds: Readonly<Record<string, AppKind>>;
	/** The server's principal and each worker's (stamped on its link). */
	readonly principal: { readonly server: P; readonly worker: (address: Address) => P };
	/** The worker kinds; none: a server with clients only. */
	readonly workers?: readonly AppWorkerKind<P>[];
	/** The caps of each host's files (the server's and every worker's). */
	readonly files?: FilesCaps;
	/** The bounds of what public endpoints and imports may cost. */
	readonly limits?: AppLimits;
	/** How installs run npm (slice 12's `InstallOptions`): `npm` on the `PATH` by default. */
	readonly install?: InstallOptions;
	readonly onError: (error: AppError) => void;
} & (OwnerPrincipal extends P ? unknown : { readonly "the app's principal type must have { kind: 'owner' }": never });

/**
 * The bounds of what public endpoints, clients and imports may cost: live ephemeral sessions (1,000; past it the
 * oldest ends, signed out), pairings under way that anonymous clients started (100 in all, 10 per client address; past
 * them 429; the owner's own are not counted), uploads under way per `Files` object (64; past it `unavailable`, `busy`),
 * an archive's unpacked bytes (4 GiB) and entries (100,000).
 */
export type AppLimits = {
	readonly uploads?: number;
	readonly ephemeralSessions?: number;
	readonly pendingPairings?: number;
	readonly pairingsPerAddress?: number;
	readonly importBytes?: number;
	readonly importEntries?: number;
};

/** The plugins of a running app, for its "apply changes" control and its installs. */
export type AppPlugins = {
	/** The marks (`dirty`, `install`, `set`, `base`): what the app's button shows. */
	readonly state: Watchable<PluginsState>;
	/** Installs plugins from git or npm into the user's root (slice 12's `installPlugin`); their names. */
	install(source: PluginSource, context: Context): Promise<readonly string[]>;
	/** The plugins component itself. */
	readonly component: Plugins;
};

/** A running app. */
export interface App<P extends Principal> {
	readonly host: Host<P>;
	readonly http: HttpComponent<P>;
	/** The workers components, by host kind name. */
	readonly workers: ReadonlyMap<string, Workers<HostKind>>;
	readonly plugins: AppPlugins;
	/** The data directory. */
	readonly dataDir: string;
	/** The owner link of this start (single use, 10 minutes): `http://127.0.0.1:<port>/_chord/owner#<token>`. */
	ownerLink(): string;
	/** The owner token file's path (a device session of the owner, mode 0600). */
	readonly ownerTokenFile: string;
	/** Builds the dirty plugins and rolls them out: the server, then every worker kind; never by itself. */
	applyChanges(context: Context): Promise<RolloutResult>;
	/** Stops the worker at `address` and writes its archive (store and files) to `path`. */
	exportAddress(address: Address, path: string, context: Context): Promise<void>;
	/** Makes `address` (which must have no data yet) from the archive at `archive`; its next hold starts it. */
	importAddress(archive: string, address: Address, context: Context): Promise<void>;
	/** Closes the HTTP component, the workers, the host, the store, the watcher and the data directory's lock. */
	close(context: Context): Promise<void>;
}

/** What `startWorker` reads from its start data besides the app's: the kit's part. */
export type KitStart = {
	readonly dir: string;
	readonly facet: string;
	readonly principal: JsonValue;
	readonly server: JsonValue;
	readonly files: { readonly maxFile?: number; readonly maxTotal?: number };
	/** The cap of uploads under way per `Files` object (`limits.uploads`). */
	readonly uploads?: number;
};

/**
 * Starts the app's server (§1): resolves once its plugins are loaded and it listens. A failing plugin of the app's
 * root (or a problem discovery reports there) rejects with the plugins component's `PluginError`, everything closed.
 */
export async function startApp<P extends Principal>(options: AppOptions<P>, context: Context): Promise<App<P>> {
	const { layout, cookieSecret, store, lock } = await openServer(
		resolve(options.dataDir ?? defaultDataDir(options.name)),
		context,
	);
	const { onError, api, limits = {} } = options;
	const host = createHost<P>({
		address: Server(),
		principal: options.principal.server,
		store,
		onError: (error) => onError({ kind: "host", error }),
	});
	const http = createHttp(
		host,
		{
			listen: options.listen ?? { host: "127.0.0.1", port: 0 },
			links: { path: "/chord" },
			onError: (error) => onError({ kind: "http", error }),
		},
		context,
	);
	const plugins = createPlugins(
		{
			roots: [{ path: resolve(options.root ?? "plugins"), required: true }, layout.plugins],
			api: { name: api.name, versions: api.versions },
			kinds: Object.fromEntries(
				Object.entries(options.kinds).map(([name, kind]) => [
					name,
					{ platform: kind.platform, hostPackages: hostPackagesOf(api, name, kind) },
				]),
			),
			install: options.install,
			onError: (error) => onError({ kind: "plugins", error }),
		},
		context,
	);
	const workers = new Map<string, Workers<HostKind>>();
	for (const kind of options.workers ?? []) {
		workers.set(kind.kind.kind, workersOf(host, kind, options, layout.dataDir, plugins, context));
	}
	const link = new OwnerLink();
	const core: PluginFacet<P>[] = [
		{ name: "chord.http", facet: http.facet },
		{
			name: "chord.app.info",
			facet: appInfoFacet({ dataDir: layout.dataDir, name: options.name, version: api.versions[0] ?? "" }),
		},
		{ name: "chord.app.sessions", facet: sessionsFacet(cookieSecret, { maxEphemeral: limits.ephemeralSessions }) },
		{ name: "chord.app.owner", facet: ownerFacet(link) },
		{
			name: "chord.app.pairing",
			facet: pairingFacet(
				new Pairings({ maxPending: limits.pendingPairings, perAddress: limits.pairingsPerAddress }),
			),
		},
		{ name: "chord.app.files", facet: filesFacet(join(layout.server, "files"), options.files, limits.uploads) },
	];
	const app = new RunningApp(host, http, workers, plugins, { store, lock }, layout, options);
	try {
		await plugins.load(host, { kind: "server", core, modules: modulesOf(api, options.kinds.server) }, context);
		await ownerTokenFile(layout.ownerToken, host, context);
		app.started(link.renew(), await http.listening(context));
	} catch (error) {
		await app.close(context);
		throw error;
	}
	return app;
}

/** How long a second server waits for the data directory's lock before it is refused. */
const SERVER_LOCK_MS = 1000;

/**
 * The server's own part of the data directory `path`: its lock (one server per data directory, by its real path: a
 * second one, also through a symbolic link, would share its stores and secrets), the layout made private, the cookie
 * secret and the server's store; the lock released when the rest fails.
 */
async function openServer(
	path: string,
	context: Context,
): Promise<{ layout: AppLayout; cookieSecret: string; store: Store; lock: ProcessLock }> {
	const dataDir = await openDataDir(path);
	const waited = AbortSignal.timeout(SERVER_LOCK_MS);
	const lock = await processLock(`chord-app:${dataDir}`, withAbortSignal(waited, context)).catch((error: unknown) => {
		throw waited.aborted ? new Error(`startApp: another server runs on ${dataDir}`) : error;
	});
	try {
		const layout = await createLayout(dataDir);
		const cookieSecret = await secretFile(layout.cookieSecret);
		await privateStore(layout.serverStore);
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(layout.serverStore)), context);
		return { layout, cookieSecret, store, lock };
	} catch (error) {
		await lock.release();
		throw error;
	}
}

/** The host packages of kind `name`: the API's shared and per-kind module of every version, and its packages. */
function hostPackagesOf(api: AppApi, name: string, kind: AppKind): string[] {
	const modules = api.versions.flatMap((version) => [`${api.name}/${version}`, `${api.name}/${version}/${name}`]);
	return [...modules, ...Object.keys(kind.packages ?? {})];
}

/** This process's modules for a kind: the API's and the kind's packages. */
function modulesOf(api: AppApi, kind: AppKind | undefined): HostPackages {
	return { ...api.modules, ...kind?.packages };
}

/** The workers component of one worker kind: started with the kit's part of the start data beside the app's. */
function workersOf<P extends Principal>(
	host: Host<P>,
	kind: AppWorkerKind<P>,
	options: AppOptions<P>,
	dataDir: string,
	plugins: Plugins,
	context: Context,
): Workers<HostKind> {
	const facet = kind.facet ?? "worker";
	return createWorkers(
		host,
		// A host kind of the app: any params; its addresses come back from its route as the kit hands them on.
		kind.kind as HostKind,
		{
			kind: facet,
			entry: kind.entry,
			...(kind.execArgv === undefined ? {} : { execArgv: kind.execArgv }),
			...(kind.env === undefined ? {} : { env: kind.env }),
			authorize: kind.authorize,
			principal: options.principal.worker,
			start: async (address, ctx) => {
				const kit: KitStart = {
					dir: workerDirectory(dataDir, address),
					facet,
					// Principals are JSON (they cross links).
					principal: options.principal.worker(address) as unknown as JsonValue,
					server: options.principal.server as unknown as JsonValue,
					files: { ...options.files },
					...(options.limits?.uploads === undefined ? {} : { uploads: options.limits.uploads }),
				};
				return { kit, app: await kind.start(address, ctx) };
			},
			lock: (address) => workerLock(options.name, dataDir, address),
			...(kind.idleMs === undefined ? {} : { idleMs: kind.idleMs }),
			plugins,
			onError: (error) => options.onError({ kind: "workers", error }),
		},
		context,
	);
}

/** The process lock of the worker at `address`: its worker holds it while it runs, an export or import meanwhile. */
function workerLock(name: string, dataDir: string, address: Address): string {
	return `${name}:${dataDir}:${address.key}`;
}

/** An address `#quiesce` made quiet: its worker's lock, and whether it was failed before. */
type Quiet = { readonly lock: ProcessLock; readonly failed: boolean };

/** How long an export or import waits for a stopped worker's lock before it stops the worker again. */
const ADDRESS_LOCK_MS = 2000;

/** The host of the owner link for the address listened on: loopback for a wildcard, an IPv6 address in brackets. */
function linkHost(host: string): string {
	if (host === "0.0.0.0" || host === "") return "127.0.0.1";
	if (host === "::") return "[::1]";
	return host.includes(":") ? `[${host}]` : host;
}

class RunningApp<P extends Principal> implements App<P> {
	readonly host: Host<P>;
	readonly http: HttpComponent<P>;
	readonly workers: ReadonlyMap<string, Workers<HostKind>>;
	readonly plugins: AppPlugins;
	readonly dataDir: string;
	readonly ownerTokenFile: string;
	readonly #component: Plugins;
	readonly #store: Store;
	readonly #lock: ProcessLock;
	readonly #options: AppOptions<P>;
	#link = "";
	#closing: Promise<void> | undefined;

	constructor(
		host: Host<P>,
		http: HttpComponent<P>,
		workers: ReadonlyMap<string, Workers<HostKind>>,
		plugins: Plugins,
		server: { readonly store: Store; readonly lock: ProcessLock },
		layout: { readonly dataDir: string; readonly plugins: string; readonly ownerToken: string },
		options: AppOptions<P>,
	) {
		this.host = host;
		this.http = http;
		this.workers = workers;
		this.#component = plugins;
		this.#store = server.store;
		this.#lock = server.lock;
		this.#options = options;
		this.dataDir = layout.dataDir;
		this.ownerTokenFile = layout.ownerToken;
		this.plugins = {
			state: plugins.state,
			install: (source, context) => plugins.installPlugin(source, layout.plugins, context),
			component: plugins,
		};
	}

	/** The start finished: the owner link's token and the address it names (the one listened on). */
	started(token: string, listening: ListenAddress): void {
		this.#link = `http://${linkHost(listening.host)}:${listening.port}${OWNER_PATH}#${token}`;
	}

	ownerLink(): string {
		return this.#link;
	}

	async applyChanges(context: Context): Promise<RolloutResult> {
		const plugins = this.#component;
		const built = await plugins.build(plugins.state.value.dirty, context);
		const steps = [plugins.step("server", this.host), ...[...this.workers].map(([name, each]) => each.step(name))];
		return plugins.rollout(steps, built, context);
	}

	async exportAddress(address: Address, path: string, context: Context): Promise<void> {
		const quiet = await this.#quiesce(address, context);
		try {
			const manifest = this.#manifest(address);
			await packAddress(workerDirectory(this.dataDir, address), manifest, resolve(path), context);
		} finally {
			await this.#resume(address, quiet, context);
		}
	}

	async importAddress(archive: string, address: Address, context: Context): Promise<void> {
		const { name, limits = {} } = this.#options;
		const accept = (manifest: ArchiveManifest): void => {
			// A trust boundary: an archive from anywhere.
			if (manifest?.format !== ARCHIVE_FORMAT)
				throw new Error(`importAddress: not a format ${ARCHIVE_FORMAT} archive`);
			if (manifest.app !== name) throw new Error(`importAddress: an archive of "${manifest.app}", not "${name}"`);
		};
		const quiet = await this.#quiesce(address, context);
		try {
			const bounds = { bytes: limits.importBytes, entries: limits.importEntries };
			await unpackAddress(resolve(archive), workerDirectory(this.dataDir, address), accept, bounds, context);
		} finally {
			await this.#resume(address, quiet, context);
		}
	}

	/**
	 * Takes the process lock of the worker at `address` (the one its worker takes at start) for an export or an import,
	 * stopping a worker that is not failed first: while it is held, a hold arriving starts a worker that waits for it,
	 * then opens the finished state. A worker started between the stop and the lock holds the lock first: it is
	 * stopped again (at most 5 times). A failed address stays failed: it starts nothing (its holds see its failure),
	 * and `#resume` leaves it so.
	 */
	async #quiesce(address: Address, context: Context): Promise<Quiet> {
		const workers = this.#workersOf(address);
		const failed = workers.state.value[address.key]?.status === "failed";
		for (let attempt = 1; ; attempt++) {
			if (!failed) await workers.stop(address, context);
			const waited = AbortSignal.timeout(ADDRESS_LOCK_MS);
			try {
				const lock = await processLock(
					workerLock(this.#options.name, this.dataDir, address),
					withAbortSignal(waited, context),
				);
				return { lock, failed };
			} catch (error) {
				if (!waited.aborted) throw error;
				if (attempt === 5) throw new Error(`app: the worker at ${address.key} keeps starting; try again`);
			}
		}
	}

	/** Releases the lock `#quiesce` took, and lets the address start again unless it was failed before. */
	async #resume(address: Address, quiet: Quiet, context: Context): Promise<void> {
		await quiet.lock.release();
		if (!quiet.failed) await this.#workersOf(address).retry(address, context);
	}

	close(context: Context): Promise<void> {
		this.#closing ??= this.#close(context);
		return this.#closing;
	}

	/** The workers of `address`'s kind. */
	#workersOf(address: Address): Workers<HostKind> {
		const workers = this.workers.get(address.kind);
		if (workers === undefined) throw new Error(`app: no worker kind "${address.kind}"`);
		return workers;
	}

	/** The manifest of `address`'s archive. */
	#manifest(address: Address): ArchiveManifest {
		const { name, api } = this.#options;
		return {
			format: ARCHIVE_FORMAT,
			app: name,
			api: api.versions[0] ?? "",
			address: { kind: address.kind, key: address.key },
		};
	}

	/**
	 * The close, in order: HTTP first (it drains requests the host's close would seal), workers, host, store, the
	 * plugins' watcher, then the data directory's lock.
	 */
	async #close(context: Context): Promise<void> {
		await this.http.close(context);
		for (const workers of this.workers.values()) await workers.close(context);
		await this.host.close(context);
		await this.#store.close(context);
		this.#component.close();
		await this.#lock.release();
	}
}
