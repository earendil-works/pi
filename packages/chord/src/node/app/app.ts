// `startServer` (slice 13 §1, §5; decisions "The app kit, point 1" to "point 5"): the server of an app built with the kit.
// It lays out the data directory, opens the server's store, creates the server host, the HTTP component and one
// workers component per worker kind, the plugins component over the app's required root and the user's root, loads
// the server's plugins with the kit's own facets (the start-data object, sessions, the owner link, pairing, files),
// and gives the app the controls it needs: the owner link, `applyChanges`, installs, export and import per address.

import { join, resolve, sep } from "node:path";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { type Context, withAbortSignal } from "../../context/index.ts";
import { type Address, type HostKind, hostKind, type KindShape } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { principalKey, samePrincipal } from "../../data/principal.ts";
import {
	createHost,
	type Facet,
	type Host,
	type HostError,
	type PluginFacet,
	type PrincipalAttributes,
} from "../../host/index.ts";
import { isJsonValue, type JsonValue } from "../../json.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { openStore, type Store, sqliteBackend } from "../../store/index.ts";
import { localeChoiceFacet, themeChoiceFacet, themesFacet, translationsFacet } from "../../surfaces/index.ts";
import { type TelemetryIngestTarget, telemetryIngestFacet } from "../../telemetry-ingest/index.ts";
import type { Watchable } from "../../watch.ts";
import { createHttp, type HttpComponent, type HttpError, type ListenAddress } from "../http/index.ts";
import {
	type BaseInputs,
	createPlugins,
	type HostPackages,
	type InstallOptions,
	type PluginSource,
	type Plugins,
	type PluginsError,
	type PluginsState,
	type RolloutResult,
	type RolloutStep,
} from "../plugins/index.ts";
import {
	processConditions,
	type TuiSurfaceOptions,
	tuiSurface,
	WEB_PREFIX,
	type WebSurfaceOptions,
	webSurface,
} from "../surfaces/index.ts";
import {
	createWorkers,
	nodeBaseInputs,
	type ProcessLock,
	processLock,
	type Workers,
	type WorkersError,
} from "../workers/index.ts";
import { ARCHIVE_FORMAT, type ArchiveManifest, packData, unpackData } from "./archive.ts";
import { addressParam, HostData } from "./data.ts";
import { type FilesCaps, filesFacet } from "./files.ts";
import { appInfoFacet } from "./info.ts";
import { type AppLayout, createLayout, defaultDataDir, openDataDir, privateStore, workerDirectory } from "./layout.ts";
import { OWNER_PATH, OwnerLink, ownerFacet, ownerTokenFile } from "./owner.ts";
import { Pairings, pairingFacet } from "./pairing.ts";
import { secretFile } from "./secrets.ts";
import { createSessions } from "./sessions.ts";

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
	/**
	 * The worker's entry module (it calls `startWorker`), bundled with the base code it imports at start (every worker of
	 * the kind runs that snapshot until the server restarts); its Node flags and environment.
	 */
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

/**
 * What the kit reports: from its host, its HTTP component, its workers or its plugins, or a failed scan of the server's
 * own code (`server_scan`: the server starts, that code is not compared).
 */
export type AppError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "http"; readonly error: HttpError }
	| { readonly kind: "workers"; readonly error: WorkersError }
	| { readonly kind: "plugins"; readonly error: PluginsError }
	| { readonly kind: "server_scan"; readonly error: unknown };

/**
 * What `startServer` takes. Worker kinds need `principal.worker`: a type error without it, also for a `workers` list
 * typed as an array (not a tuple) that is empty.
 */
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
	/**
	 * The server's principal, each worker's (stamped on its link; only with worker kinds) and the owner's: whom the owner
	 * link, the owner token file and device pairing sign in, and who approves pairings and makes invites (`AppInfo.owner`).
	 * The owner must be strict JSON and not the server's principal (refused at start).
	 */
	readonly principal: { readonly server: P; readonly worker?: (address: Address) => P; readonly owner: P };
	/** The worker kinds; none: a server with clients only. */
	readonly workers?: readonly AppWorkerKind<P>[];
	/** The caps of each host's files (the server's and every worker's). */
	readonly files?: FilesCaps;
	/** The bounds of what public endpoints and imports may cost. */
	readonly limits?: AppLimits;
	/** How installs run npm (slice 12's `InstallOptions`): `npm` on the `PATH` by default. */
	readonly install?: InstallOptions;
	/**
	 * The web surface (slice 11): the app's web entry (the base bundle's), its page template, the paths serving the
	 * page (`["/"]`), whether the page is public, the conditions its packages resolve with (the server process's by
	 * default); the `web` facet kind. None: no web surface.
	 */
	readonly web?: AppWeb;
	/**
	 * The terminal surface (slice 11): the app's terminal entry and the conditions its packages resolve with (the server
	 * process's by default); the `tui` facet kind. None: no terminal clients.
	 */
	readonly tui?: Pick<TuiSurfaceOptions, "entry" | "conditions">;
	/**
	 * The app's telemetry store (§29; decision "The server is the one place telemetry is stored"): the server's host,
	 * its HTTP requests and the kit's ingest record to it (`createSqliteTelemetry`'s store). With one, every worker
	 * records in memory and sends its spans and metrics to the server's `WorkerTelemetry`, and pages that record
	 * (`startPage({ telemetry: true })`) theirs to `PageTelemetry`; carriers join them into one trace. None: NOOP.
	 */
	readonly telemetry?: TelemetryContext & TelemetryIngestTarget;
	/**
	 * Who a span was for (`createHost`'s `principalAttributes`): the server's hook, also stamped on the spans pages
	 * send (the principal of their link). Each worker's is its `startWorker`'s.
	 */
	readonly principalAttributes?: PrincipalAttributes<P>;
	/**
	 * The app's base code beside what the kit knows (files or directories: its API modules, its start script), hashed at
	 * start: `plugins.state.base` is true while a file differs from what the server or a base bundle read (or a source
	 * file is new in one of the directories). The kit adds every file its base bundles were built from, with the bytes
	 * they read: the web's, the terminal's and each worker kind's.
	 */
	readonly base?: readonly string[];
	/**
	 * The `closeTimeout`, `readyTimeout` and `reloadDrainTimeout` of every host (the server's and each worker's): 30 s,
	 * 60 s and 5 s by default.
	 */
	readonly timeouts?: AppTimeouts;
	readonly onError: (error: AppError) => void;
} & ({ readonly workers?: readonly [] } | { readonly principal: { readonly worker: (address: Address) => P } });

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

/**
 * The hosts' timeouts in milliseconds (`HostOptions.closeTimeout`, `HostOptions.readyTimeout`,
 * `HostOptions.reloadDrainTimeout`).
 */
export type AppTimeouts = {
	readonly closeTimeout?: number;
	readonly readyTimeout?: number;
	readonly reloadDrainTimeout?: number;
};

/** The kit's web surface options (`webSurface`'s, its kind `web` and plugins the kit's). */
export type AppWeb = Pick<WebSurfaceOptions, "entry" | "page" | "paths" | "public" | "conditions">;

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
	/** The web surface's base bundle hash, when the app has one. */
	readonly web: { readonly base: string } | undefined;
	/** The terminal surface's base bundle hash, when the app has one. */
	readonly tui: { readonly base: string } | undefined;
	/** The data directory. */
	readonly dataDir: string;
	/** The owner link of this start (single use, 10 minutes): `http://127.0.0.1:<port>/_chord/owner#<token>`. */
	ownerLink(): string;
	/** The owner token file's path (a device session of the owner, mode 0600). */
	readonly ownerTokenFile: string;
	/**
	 * Builds the dirty plugins and rolls them out: the server, every worker kind, then the clients; never by itself. Calls
	 * run one after another (a later one builds after the earlier one rolled out).
	 */
	applyChanges(context: Context): Promise<RolloutResult>;
	/**
	 * Writes the data the worker at `address` created (its store and finished files) as an archive at `path`, stopping
	 * nothing: a running worker packs its own store at one consistent point; without one the server packs it under the
	 * worker's lock (no worker starts meanwhile).
	 */
	exportData(address: Address, path: string, context: Context): Promise<void>;
	/**
	 * Makes the data of `address` (which must have none yet: nothing is overwritten) from the archive at `archive`,
	 * under the worker's lock; its next hold starts it.
	 */
	importData(archive: string, address: Address, context: Context): Promise<void>;
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
	/** Whether the server has a telemetry store: the worker then sends what it records to `WorkerTelemetry`. */
	readonly telemetry: boolean;
	/** The cap of uploads under way per `Files` object (`limits.uploads`). */
	readonly uploads?: number;
	/** The app's host timeouts (`timeouts`), the worker's host takes them too. */
	readonly timeouts: AppTimeouts;
};

/**
 * Starts the app's server (§1): resolves once its plugins are loaded and it listens. A failing plugin of the app's
 * root (or a problem discovery reports there) rejects with the plugins component's `PluginError`, everything closed.
 */
export async function startServer<P extends Principal>(options: AppOptions<P>, context: Context): Promise<App<P>> {
	checkOwner(options.principal.owner, options.principal.server, context);
	const { layout, cookieSecret, store, lock } = await openServer(
		resolve(options.dataDir ?? defaultDataDir(options.name)),
		context,
	);
	const { onError, api, limits = {} } = options;
	const sessions = createSessions<P>(cookieSecret, { maxEphemeral: limits.ephemeralSessions });
	const { telemetry, principalAttributes } = options;
	const host = createHost<P>({
		address: Server(),
		principal: options.principal.server,
		store,
		telemetry,
		...(principalAttributes === undefined ? {} : { principalAttributes }),
		...options.timeouts,
		onError: (error) => onError({ kind: "host", error }),
	});
	const http = createHttp(
		host,
		{
			listen: options.listen ?? { host: "127.0.0.1", port: 0 },
			links: { path: "/chord", opened: sessions.opened },
			telemetry,
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
			// The server's own base code, hashed now; each base bundle's record is added once built (`watchBase`).
			base: (options.base ?? []).map((path) => resolve(path)),
			publicPath: `${WEB_PREFIX}assets/`,
			onError: (error) => onError({ kind: "plugins", error }),
		},
		context,
	);
	const workers = new Map<string, Workers<HostKind>>();
	// The address key of each worker by its principal's key: the principal its link stamps on its telemetry batches.
	const workerHosts = new Map<string, string>();
	const link = new OwnerLink();
	const { owner } = options.principal;
	const core: PluginFacet<P>[] = [
		{ name: "chord.http", facet: http.facet },
		{
			name: "chord.app.info",
			facet: appInfoFacet({ dataDir: layout.dataDir, name: options.name, version: api.versions[0] ?? "", owner }),
		},
		{ name: "chord.app.sessions", facet: sessions.facet },
		{ name: "chord.app.owner", facet: ownerFacet(link, owner) },
		{
			name: "chord.app.pairing",
			facet: pairingFacet(
				new Pairings({ maxPending: limits.pendingPairings, perAddress: limits.pairingsPerAddress }),
				owner,
			),
		},
		{ name: "chord.app.files", facet: filesFacet(join(layout.server, "files"), options.files, limits.uploads) },
		{ name: "chord.themes", facet: themesFacet() },
		{ name: "chord.themes.choice", facet: themeChoiceFacet() },
		{ name: "chord.translations", facet: translationsFacet() },
		{ name: "chord.locale.choice", facet: localeChoiceFacet() },
	];
	if (telemetry !== undefined) {
		const facet = telemetryIngestFacet<P>({
			target: telemetry,
			workerHost: (principal) => workerHosts.get(principalKey(principal, context)),
			principalAttributes: (principal) => host.principalAttributes(principal, context),
		});
		core.push({ name: "chord.telemetry", facet });
	}
	const surfaces: Surface<P>[] = [];
	const app = new RunningApp(host, http, workers, plugins, surfaces, { store, lock }, layout, options);
	try {
		// The server's own code, the static graph of its entry (the start script): compared like every base bundle's.
		// An entry under `node_modules` is installed code (an npm-installed app, a test runner), never compared.
		const entry = process.argv[1];
		if (entry !== undefined && !entry.split(sep).includes("node_modules")) {
			const conditions = processConditions(process.execArgv, process.env.NODE_OPTIONS);
			// Best effort: a scan that fails stops nothing; that code is then not compared.
			await nodeBaseInputs(entry, conditions).then(
				(inputs) => plugins.watchBase(inputs),
				(error: unknown) => onError({ kind: "server_scan", error }),
			);
		}
		// Each worker kind's base bundled now: one that does not build fails the start, everything closed.
		for (const kind of options.workers ?? []) {
			workers.set(
				kind.kind.kind,
				await workersOf(host, kind, options, layout.dataDir, plugins, workerHosts, context),
			);
		}
		for (const surface of await surfacesOf(host, options, plugins, context)) {
			surfaces.push(surface);
			core.push({ name: `chord.${surface.name}`, facet: surface.facet });
		}
		for (const { inputs } of [...surfaces, ...workers.values()]) plugins.watchBase(inputs);
		await plugins.load(host, { kind: "server", core, modules: modulesOf(api, options.kinds.server) }, context);
		await ownerTokenFile(layout.ownerToken, owner, host, context);
		app.started(link.renew(), await http.listening(context));
	} catch (error) {
		await app.close(context);
		throw error;
	}
	return app;
}

/**
 * Refuses an owner the kit could not recognize or that would act as the server (a declaration policy the types cannot
 * express): sessions keep the owner as JSON, so a field `undefined` (or anything else not strict JSON) would never
 * match it again; the server's principal reaches every worker's kit objects.
 */
function checkOwner<P extends Principal>(owner: P, server: P, context: Context): void {
	if (!isJsonValue(owner)) {
		throw new Error(
			"startServer: principal.owner must be strict JSON (no undefined fields, functions or class instances)",
		);
	}
	if (samePrincipal(owner, server, context)) {
		throw new Error("startServer: principal.owner must not be the server's principal");
	}
}

/** A client surface of the app: its name (`web`, `tui`), its facet, its rollout step, its base bundle's hash. */
type Surface<P extends Principal> = {
	readonly name: "web" | "tui";
	readonly facet: Facet<P>;
	step(name: string): RolloutStep;
	readonly base: string;
	/** The files its base bundle was built from, with their bytes' hashes. */
	readonly inputs: BaseInputs;
};

/** The app's client surfaces, built (their base bundles) in order: the web's, the terminal's. */
async function surfacesOf<P extends Principal>(
	host: Host<P>,
	options: AppOptions<P>,
	plugins: Plugins,
	context: Context,
): Promise<Surface<P>[]> {
	const surfaces: Surface<P>[] = [];
	if (options.web !== undefined)
		surfaces.push({ name: "web", ...(await webSurface(host, { ...options.web, plugins }, context)) });
	if (options.tui !== undefined) {
		surfaces.push({ name: "tui", ...(await tuiSurface(host, { ...options.tui, plugins }, context)) });
	}
	return surfaces;
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
		throw waited.aborted ? new Error(`startServer: another server runs on ${dataDir}`) : error;
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

/**
 * The workers component of one worker kind, its base bundled: started with the kit's part of the start data beside the
 * app's.
 */
function workersOf<P extends Principal>(
	host: Host<P>,
	kind: AppWorkerKind<P>,
	options: AppOptions<P>,
	dataDir: string,
	plugins: Plugins,
	workerHosts: Map<string, string>,
	context: Context,
): Promise<Workers<HostKind>> {
	const facet = kind.facet ?? "worker";
	// `AppOptions` admits worker kinds only with `principal.worker`.
	const worker = options.principal.worker as (address: Address) => P;
	const { server } = options.principal;
	return createWorkers(
		host,
		// A host kind of the app: any params; its addresses come back from its route as the kit hands them on.
		kind.kind as HostKind,
		{
			kind: facet,
			entry: kind.entry,
			...(kind.execArgv === undefined ? {} : { execArgv: kind.execArgv }),
			...(kind.env === undefined ? {} : { env: kind.env }),
			// The server reaches its workers' kit objects (`HostData`) whatever the app admits.
			authorize: (principal, address) =>
				samePrincipal(principal, server, context) || kind.authorize(principal, address),
			principal: worker,
			start: async (address, ctx) => {
				const principal = worker(address);
				workerHosts.set(principalKey(principal, ctx), address.key);
				const kit: KitStart = {
					dir: workerDirectory(dataDir, address),
					facet,
					// Principals are JSON (they cross links).
					principal: principal as unknown as JsonValue,
					server: server as unknown as JsonValue,
					files: { ...options.files },
					telemetry: options.telemetry !== undefined,
					...(options.limits?.uploads === undefined ? {} : { uploads: options.limits.uploads }),
					timeouts: { ...options.timeouts },
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

/** How long an export or import waits for a worker's lock: past it a worker holds it (it runs or starts). */
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
	/** The client surfaces, filled before the server's load. */
	readonly #surfaces: readonly Surface<P>[];
	readonly #store: Store;
	readonly #lock: ProcessLock;
	readonly #options: AppOptions<P>;
	#link = "";
	#closing: Promise<void> | undefined;
	/** The latest `applyChanges`, settled to nothing: the next one starts after it. */
	#applying: Promise<void> = Promise.resolve();

	constructor(
		host: Host<P>,
		http: HttpComponent<P>,
		workers: ReadonlyMap<string, Workers<HostKind>>,
		plugins: Plugins,
		surfaces: readonly Surface<P>[],
		server: { readonly store: Store; readonly lock: ProcessLock },
		layout: { readonly dataDir: string; readonly plugins: string; readonly ownerToken: string },
		options: AppOptions<P>,
	) {
		this.host = host;
		this.http = http;
		this.workers = workers;
		this.#component = plugins;
		this.#surfaces = surfaces;
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

	get web(): { readonly base: string } | undefined {
		return this.#surfaces.find(({ name }) => name === "web");
	}

	get tui(): { readonly base: string } | undefined {
		return this.#surfaces.find(({ name }) => name === "tui");
	}

	applyChanges(context: Context): Promise<RolloutResult> {
		// One build and rollout at a time: a later build rolled out before an earlier one would leave the older code
		// deployed (each host applies the last set it is handed).
		const applied = this.#applying.then(() => this.#applyChanges(context));
		this.#applying = applied.then(
			() => {},
			() => {},
		);
		return applied;
	}

	/** One build of the dirty plugins and its rollout: the server, every worker kind, then the clients. */
	async #applyChanges(context: Context): Promise<RolloutResult> {
		const plugins = this.#component;
		const built = await plugins.build(plugins.state.value.dirty, context);
		const steps = [
			plugins.step("server", this.host),
			...[...this.workers].map(([name, each]) => each.step(name)),
			...this.#surfaces.map((surface) => surface.step(surface.name)),
		];
		return plugins.rollout(steps, built, context);
	}

	async exportData(address: Address, path: string, context: Context): Promise<void> {
		const workers = this.#workersOf(address);
		const manifest = this.#manifest(address);
		const target = resolve(path);
		// Running: the worker packs its own store. Else the lock, unless a worker starts first: then ask it.
		for (let attempt = 1; ; attempt++) {
			if (workers.state.value[address.key]?.status === "running") {
				const data = await this.host.get(HostData, { address: addressParam(address) }, context);
				try {
					await data.exportTo({ path: target, manifest: JSON.stringify(manifest) }, context);
				} finally {
					data.release();
				}
				return;
			}
			const lock = await this.#workerLock(address, context);
			if (lock !== undefined) {
				try {
					await packData(workerDirectory(this.dataDir, address), manifest, target, context);
				} finally {
					await lock.release();
				}
				return;
			}
			if (attempt === 5) throw new Error(`exportData: the worker at ${address.key} keeps starting; try again`);
		}
	}

	async importData(archive: string, address: Address, context: Context): Promise<void> {
		this.#workersOf(address);
		const { name, limits = {} } = this.#options;
		const accept = (manifest: ArchiveManifest): void => {
			// A trust boundary: an archive from anywhere.
			if (manifest?.format !== ARCHIVE_FORMAT) throw new Error(`importData: not a format ${ARCHIVE_FORMAT} archive`);
			if (manifest.app !== name) throw new Error(`importData: an archive of "${manifest.app}", not "${name}"`);
		};
		const lock = await this.#workerLock(address, context);
		// A worker holds it: it runs, so the address has data, and nothing is overwritten.
		if (lock === undefined) throw new Error(`importData: ${address.key} has data (its worker runs)`);
		try {
			const bounds = { bytes: limits.importBytes, entries: limits.importEntries };
			await unpackData(resolve(archive), workerDirectory(this.dataDir, address), accept, bounds, context);
		} finally {
			await lock.release();
		}
	}

	/** The process lock of the worker at `address` (the one its worker takes at start), or `undefined` while held. */
	async #workerLock(address: Address, context: Context): Promise<ProcessLock | undefined> {
		const waited = AbortSignal.timeout(ADDRESS_LOCK_MS);
		try {
			return await processLock(
				workerLock(this.#options.name, this.dataDir, address),
				withAbortSignal(waited, context),
			);
		} catch (error) {
			if (waited.aborted) return undefined;
			throw error;
		}
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
