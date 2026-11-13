// `startServer` (slice 13 §1, §5; decisions "The app kit, point 1" to "point 5"): the server of an app built with the kit.
// It lays out the data directory, opens the server's store, creates the server host, the HTTP component and one
// workers component per worker kind, the plugins component over the app's required root and the user's root, loads
// the server's plugins with the kit's own facets (the start-data object, sign-ins, the owner link, pairing, files),
// and gives the app the controls it needs: the owner link, `applyChanges`, installs, export, import and delete per
// address (the worker's data and the server's records and rows belonging to the address).
// After the listen, off the start's path, it builds the bases (the surfaces' base bundles, each worker kind's worker
// base) and records the base code the `base` mark compares.

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { type Context, withAbortSignal } from "../../context/index.ts";
import { type Address, type HostKind, hostKind, type KindShape } from "../../contracts/index.ts";
import { isChordError, type Principal } from "../../data/index.ts";
import { principalKey, samePrincipal } from "../../data/principal.ts";
import { createHost, type Host, type HostError, type PluginFacet, type PrincipalAttributes } from "../../host/index.ts";
import { isJsonValue, type JsonValue } from "../../json.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { decodeJsonl, encodeJsonl, openStore, type Store, sqliteBackend } from "../../store/index.ts";
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
} from "../plugins/index.ts";
import {
	processConditions,
	type SurfaceBuilt,
	type TuiSurface,
	type TuiSurfaceOptions,
	tuiSurface,
	WEB_PREFIX,
	type WebRoutesOptions,
	type WebSurface,
	type WebSurfaceOptions,
	webSurface,
} from "../surfaces/index.ts";
import {
	createWorkers,
	nodeBaseInputs,
	type ProcessLock,
	processLock,
	type Workers,
	type WorkersBuilt,
	type WorkersError,
} from "../workers/index.ts";
import { ARCHIVE_FORMAT, type ArchiveManifest, exists, packData, unpackStaging } from "./archive.ts";
import { addressParam, HostData } from "./data.ts";
import { type FilesCaps, filesFacet } from "./files.ts";
import { appInfoFacet } from "./info.ts";
import { type AppLayout, createLayout, defaultDataDir, openDataDir, privateStore, workerDirectory } from "./layout.ts";
import { OWNER_PATH, OwnerLink, ownerFacet, ownerTokenFile } from "./owner.ts";
import { Pairings, pairingFacet } from "./pairing.ts";
import { secretFile } from "./secrets.ts";
import { createSignIns } from "./sign-ins.ts";

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
 * What the kit reports: from its host, its HTTP component, its workers or its plugins, a base that did not build after
 * the start (`base_build`: `base` is `web`, `tui` or the worker kind's name; the server runs on, the page answers 503,
 * the kind's workers fail their start), or a failed scan of the server's own code (`server_scan`: the server runs on,
 * that code is not compared).
 */
export type AppError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "http"; readonly error: HttpError }
	| { readonly kind: "workers"; readonly error: WorkersError }
	| { readonly kind: "plugins"; readonly error: PluginsError }
	| { readonly kind: "base_build"; readonly base: string; readonly error: unknown }
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
 * The bounds of what public endpoints, clients and imports may cost: live ephemeral sign-ins (1,000; past it the
 * oldest ends, signed out), pairings under way that anonymous clients started (100 in all, 10 per client address; past
 * them 429; the owner's own are not counted), uploads under way per `Files` object (64; past it `unavailable`, `busy`),
 * an archive's unpacked bytes (4 GiB) and entries (100,000).
 */
export type AppLimits = {
	readonly uploads?: number;
	readonly ephemeralSignIns?: number;
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
export type AppWeb = Pick<WebSurfaceOptions, "entry" | "conditions"> & Omit<WebRoutesOptions, "routes">;

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
	/**
	 * The web surface, when the app has one: its base bundle's hash once built (`basesBuilt`); `undefined` before, and
	 * when its build failed.
	 */
	readonly web: { readonly base: string | undefined } | undefined;
	/** The terminal surface, when the app has one: its base bundle's hash, as `web`'s. */
	readonly tui: { readonly base: string | undefined } | undefined;
	/** The data directory. */
	readonly dataDir: string;
	/** The owner link of this start (single use, 10 minutes): `http://127.0.0.1:<port>/_chord/owner#<token>`. */
	ownerLink(): string;
	/** The owner token file's path (a device sign-in of the owner, mode 0600). */
	readonly ownerTokenFile: string;
	/**
	 * Settles once every base (the web and terminal base bundles, each worker kind's worker base) was built after the
	 * start, or failed (reported, `base_build`). Never rejects.
	 */
	readonly basesBuilt: Promise<void>;
	/**
	 * Settles once the base code is recorded, watched and compared once, after the start: the bases' records (after
	 * `basesBuilt`) and the scan of the server's own code. Until then `plugins.state.base` is not known (`false` may
	 * mean "not compared yet"); a file of the server's own code changed since the process started marks it until a
	 * restart (Node may have loaded other bytes than the scan read).
	 */
	readonly baseWatched: Promise<void>;
	/**
	 * Builds the dirty plugins and rolls them out: the server, every worker kind, then the clients; never by itself. Calls
	 * run one after another (a later one builds after the earlier one rolled out).
	 */
	applyChanges(context: Context): Promise<RolloutResult>;
	/**
	 * Writes the data of the worker at `address` (its store and finished files, and the server's records and rows
	 * belonging to the address) as an archive at `path`, stopping nothing: a running worker packs its own store at one
	 * consistent point; without one the server packs it under the worker's lock (no worker starts meanwhile).
	 */
	exportData(address: Address, path: string, context: Context): Promise<void>;
	/**
	 * Makes the data of `address` from the archive at `archive` (an archive of an address of its kind; another address
	 * is a copy: the server's host cells and keys are rewritten), under the worker's lock; its next hold starts it. An
	 * address with data (a directory, server records or rows) is refused, unless `options.existing` is `"replace"`:
	 * then its data is replaced. A refused or definitely failed import is undone (the old directory back, nothing new
	 * left); one whose server commit has an unknown outcome (`storage_failed`) undoes nothing: the new directory stays in
	 * place and the old one aside, and the rejection says so.
	 */
	importData(archive: string, address: Address, context: Context, options?: DataImportOptions): Promise<void>;
	/**
	 * Deletes the data of `address` (its worker's directory and the server's records and rows belonging to it) under
	 * the worker's lock; refused while its worker runs.
	 */
	deleteData(address: Address, context: Context): Promise<void>;
	/** Closes the HTTP component, the workers, the host, the store, the watcher and the data directory's lock. */
	close(context: Context): Promise<void>;
}

/** What `importData` takes besides the archive and the address. */
export type DataImportOptions = {
	/** What happens when the address has data: refused (the default), or replaced. */
	readonly existing?: "refuse" | "replace";
};

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
 * The bases are built right after the listen, from the files as they are then (`basesBuilt`): a page request waits
 * for its surface's, a worker start for its kind's.
 */
export async function startServer<P extends Principal>(options: AppOptions<P>, context: Context): Promise<App<P>> {
	checkOwner(options.principal.owner, options.principal.server, context);
	const { layout, cookieSecret, store, lock } = await openServer(
		resolve(options.dataDir ?? defaultDataDir(options.name)),
		context,
	);
	const { onError, api, limits = {} } = options;
	const signIns = createSignIns<P>(cookieSecret, { maxEphemeral: limits.ephemeralSignIns });
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
			links: { path: "/chord", opened: signIns.opened },
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
		{ name: "chord.app.sign-ins", facet: signIns.facet },
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
			// Every link of the kit's server is signed in: its pages are the app's own people's.
			admit: () => true,
			workerHost: (principal) => workerHosts.get(principalKey(principal, context)),
			principalAttributes: (principal) => host.principalAttributes(principal, context),
		});
		core.push({ name: "chord.telemetry", facet });
	}
	const surfaces: Surface<P>[] = [];
	const app = new RunningApp(host, http, workers, plugins, surfaces, { store, lock }, layout, options);
	// What runs after the start reports nothing once the app closes (a build or scan finishing late).
	const report = (error: AppError): void => {
		if (!app.closing()) onError(error);
	};
	try {
		for (const kind of options.workers ?? []) {
			workers.set(kind.kind.kind, workersOf(host, kind, options, layout, plugins, workerHosts, context));
		}
		for (const surface of surfacesOf(host, options, plugins)) {
			surfaces.push(surface);
			core.push({ name: `chord.${surface.name}`, facet: surface.surface.facet });
		}
		await plugins.load(host, { kind: "server", core, modules: modulesOf(api, options.kinds.server) }, context);
		await ownerTokenFile(layout.ownerToken, owner, host, context);
		const listening = await http.listening(context);
		const bases = [
			...surfaces.map(({ name, surface }) => ({ name, build: () => surface.build() })),
			...[...workers].map(([name, each]) => ({ name, build: () => each.build() })),
		];
		const compared: Promise<void>[] = [];
		const built = buildBases(bases, plugins, compared, report, () => app.closing());
		const watching = watchBaseCode(plugins, built, compared, report, () => app.closing());
		app.started(link.renew(), listening, built, watching);
	} catch (error) {
		await app.close(context);
		throw error;
	}
	return app;
}

/**
 * Refuses an owner the kit could not recognize or that would act as the server (a declaration policy the types cannot
 * express): sign-ins keep the owner as JSON, so a field `undefined` (or anything else not strict JSON) would never
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

/** A base the kit builds after the listen: its name in reports, its build. */
type Base = { readonly name: string; build(): Promise<SurfaceBuilt | WorkersBuilt> };

/**
 * Builds every base right after the listen, at once, from the files as they are now (owner decision "A": nothing is
 * kept between starts; the server answers meanwhile, each request needing a base waits for it). A built base's record
 * is added to what `plugins` compares (its first comparisons pushed to `compared`); a failed one is reported
 * (`base_build`) and the server runs on. Settles once every build ended; what ends after the close is dropped.
 */
async function buildBases(
	bases: readonly Base[],
	plugins: Plugins,
	compared: Promise<void>[],
	report: (error: AppError) => void,
	closed: () => boolean,
): Promise<void> {
	await Promise.all(
		bases.map(async ({ name, build }) => {
			const built = await build();
			if (closed()) return;
			if (built.kind === "failed") report({ kind: "base_build", base: name, error: built.error });
			else compared.push(plugins.watchBase(built.inputs));
		}),
	);
}

/**
 * Adds the server's own code to what `plugins` compares, once the bases are built (`built`; the scan's reads would
 * contend with the builds the first requests wait for): the static graph of its entry (the start script;
 * `nodeBaseInputs`; a file changed since the process started is recorded as differing, `editedSinceStart`). Best
 * effort: a failed scan is reported (`server_scan`) and that code not compared. An entry under `node_modules` is
 * installed code (an npm-installed app, a test runner), never compared. Settles once every record's first comparison
 * did (the bases' in `compared` too: `base` knows them all). A close meanwhile ends it at its next step; a scan stalled
 * on a read keeps it pending until the read ends (the close does not wait for it; its result is dropped).
 */
async function watchBaseCode(
	plugins: Plugins,
	built: Promise<void>,
	compared: Promise<void>[],
	report: (error: AppError) => void,
	closed: () => boolean,
): Promise<void> {
	await built;
	if (closed()) return;
	const entry = process.argv[1];
	if (entry !== undefined && !entry.split(sep).includes("node_modules")) {
		const conditions = processConditions(process.execArgv, process.env.NODE_OPTIONS);
		const scanned = await nodeBaseInputs(entry, conditions).then(
			(inputs) => inputs,
			(error: unknown) => report({ kind: "server_scan", error }),
		);
		if (closed()) return;
		if (scanned !== undefined) compared.push(plugins.watchBase(editedSinceStart(scanned)));
	}
	await Promise.all(compared);
}

/** What the scan records for a file changed since the process started: a hash no bytes have. */
const EDITED_SINCE_START = "changed since the server started";

/** How far in the future a file's timestamp may be and still count as an edit since the start: clock skew. */
const FUTURE_SLACK_MS = 5_000;

/**
 * The scan's record `inputs` with every file changed since this process started (its mtime or ctime after
 * `performance.timeOrigin`) recorded as differing: Node may have loaded other bytes than the scan read, so its first
 * comparison marks `base` (until a restart: the bytes Node loaded are unknown). Conservative: an edit Node loaded
 * anyway (made during the module loading, before the file was read) or a change of metadata only (ctime) marks too.
 * Per timestamp: one later than now (plus `FUTURE_SLACK_MS`) is no edit since the start (a file stamped in the future,
 * by a skewed clock or an archive, would mark every start until that time); a file neither of whose timestamps is in
 * range keeps its hash, compared by content alone.
 */
function editedSinceStart(inputs: BaseInputs): BaseInputs {
	const started = performance.timeOrigin;
	const latest = Date.now() + FUTURE_SLACK_MS;
	return new Map(
		[...inputs].map(([path, hash]) => {
			try {
				const { mtimeMs, ctimeMs } = statSync(path);
				const edited = [mtimeMs, ctimeMs].some((time) => time > started && time <= latest);
				return [path, edited ? EDITED_SINCE_START : hash];
			} catch {
				// Gone: its first comparison finds it so.
				return [path, hash];
			}
		}),
	);
}

/** A client surface of the app and its name (`web`, `tui`). */
type Surface<P extends Principal> = { readonly name: "web" | "tui"; readonly surface: WebSurface<P> | TuiSurface<P> };

/** The app's client surfaces, in order: the web's, the terminal's (their base bundles built after the listen). */
function surfacesOf<P extends Principal>(host: Host<P>, options: AppOptions<P>, plugins: Plugins): Surface<P>[] {
	const surfaces: Surface<P>[] = [];
	if (options.web !== undefined)
		surfaces.push({ name: "web", surface: webSurface(host, { ...options.web, plugins }) });
	if (options.tui !== undefined)
		surfaces.push({ name: "tui", surface: tuiSurface(host, { ...options.tui, plugins }) });
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
 * The workers component of one worker kind (its base built after the listen, into the kind's directory under
 * `cache/workers/`): started with the kit's part of the start data beside the app's.
 */
function workersOf<P extends Principal>(
	host: Host<P>,
	kind: AppWorkerKind<P>,
	options: AppOptions<P>,
	layout: AppLayout,
	plugins: Plugins,
	workerHosts: Map<string, string>,
	context: Context,
): Workers<HostKind> {
	const { dataDir } = layout;
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
			baseDir: join(layout.workerBases, kind.kind.kind),
			compileCache: layout.compileCache,
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
			lock: (address) => workerLock(options.name, dataDir, address.key),
			...(kind.idleMs === undefined ? {} : { idleMs: kind.idleMs }),
			plugins,
			onError: (error) => options.onError({ kind: "workers", error }),
		},
		context,
	);
}

/**
 * Whether a host data commit's rejection leaves its outcome unknown: the store stopped after or during `COMMIT`
 * (`unavailable/storage_failed`), so the commit may stand.
 */
function unknownOutcome(error: unknown): boolean {
	return isChordError(error) && error.code === "unavailable" && error.reason === "storage_failed";
}

/** The process lock of the worker at `address`: its worker holds it while it runs, an export or import meanwhile. */
function workerLock(name: string, dataDir: string, key: string): string {
	return `${name}:${dataDir}:${key}`;
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
	/** The bases' builds after the start (`buildBases`). */
	#building: Promise<void> = Promise.resolve();
	/** The recording of the base code after the start (`watchBaseCode`). */
	#scanning: Promise<void> = Promise.resolve();
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

	/**
	 * The start finished: the owner link's token and the address it names (the one listened on), the bases' builds and
	 * the recording of the base code under way (`basesBuilt`, `baseWatched`).
	 */
	started(token: string, listening: ListenAddress, building: Promise<void>, scanning: Promise<void>): void {
		this.#link = `http://${linkHost(listening.host)}:${listening.port}${OWNER_PATH}#${token}`;
		this.#building = building;
		this.#scanning = scanning;
	}

	ownerLink(): string {
		return this.#link;
	}

	get basesBuilt(): Promise<void> {
		return this.#building;
	}

	get baseWatched(): Promise<void> {
		return this.#scanning;
	}

	get web(): { readonly base: string | undefined } | undefined {
		return this.#surfaceBase("web");
	}

	get tui(): { readonly base: string | undefined } | undefined {
		return this.#surfaceBase("tui");
	}

	/** The surface `name`'s base hash once built, when the app has that surface. */
	#surfaceBase(name: "web" | "tui"): { readonly base: string | undefined } | undefined {
		const found = this.#surfaces.find((each) => each.name === name);
		if (found === undefined) return undefined;
		const { built } = found.surface;
		return { base: built?.kind === "built" ? built.base : undefined };
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
			...this.#surfaces.map(({ name, surface }) => surface.step(name)),
		];
		return plugins.rollout(steps, built, context);
	}

	async exportData(address: Address, path: string, context: Context): Promise<void> {
		const workers = this.#workersOf(address);
		const manifest = this.#manifest(address);
		const target = resolve(path);
		// The server's part first, staged beside the archive: the worker or `packData` packs it with the rest.
		const staging = await mkdtemp(join(dirname(target), ".chord-server-"));
		const server = join(staging, "server.archive");
		try {
			const parts = encodeJsonl(this.host.exportHostData(address, context));
			await pipeline(parts, createWriteStream(server, { mode: 0o600 }));
			await this.#exportWorker(workers, address, manifest, server, target, context);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}

	/** Packs the worker's data with the server's part `server` at `target`, by the running worker or under its lock. */
	async #exportWorker(
		workers: Workers<HostKind>,
		address: Address,
		manifest: ArchiveManifest,
		server: string,
		target: string,
		context: Context,
	): Promise<void> {
		// Running: the worker packs its own store. Else the lock, unless a worker starts first: then ask it.
		for (let attempt = 1; ; attempt++) {
			if (workers.state.value[address.key]?.status === "running") {
				const data = await this.host.get(HostData, { address: addressParam(address) }, context);
				try {
					await data.exportTo({ path: target, manifest: JSON.stringify(manifest), server }, context);
				} finally {
					data.release();
				}
				return;
			}
			const lock = await this.#workerLock(address, context);
			if (lock !== undefined) {
				try {
					await packData(workerDirectory(this.dataDir, address), manifest, server, target, context);
				} finally {
					await lock.release();
				}
				return;
			}
			if (attempt === 5) throw new Error(`exportData: the worker at ${address.key} keeps starting; try again`);
		}
	}

	async importData(
		archive: string,
		address: Address,
		context: Context,
		options: DataImportOptions = {},
	): Promise<void> {
		this.#workersOf(address);
		const { name, limits = {} } = this.#options;
		const existing = options.existing ?? "refuse";
		const accept = (manifest: ArchiveManifest): void => {
			// A trust boundary: an archive from anywhere.
			if (manifest?.format !== ARCHIVE_FORMAT) throw new Error(`importData: not a format ${ARCHIVE_FORMAT} archive`);
			if (manifest.app !== name) throw new Error(`importData: an archive of "${manifest.app}", not "${name}"`);
			if (manifest.address?.kind !== address.kind) {
				throw new Error(`importData: an archive of a ${String(manifest.address?.kind)}, not a ${address.kind}`);
			}
		};
		const dir = workerDirectory(this.dataDir, address);
		await this.#underLock(address, "importData", "has data (its worker runs)", context, async () => {
			if (existing === "refuse" && (await exists(dir))) {
				throw new Error(`importData: ${dir} exists already (an address is imported once)`);
			}
			// (1) Unpacked whole into staging: nothing changed yet.
			const bounds = { bytes: limits.importBytes, entries: limits.importEntries };
			const { staging } = await unpackStaging(resolve(archive), dirname(dir), accept, bounds, context);
			const aside = existing === "replace" && (await exists(dir)) ? `${dir}.aside-${randomUUID()}` : undefined;
			let placed = false;
			const undo = async (): Promise<void> => {
				await rm(placed ? dir : staging, { recursive: true, force: true });
				if (aside !== undefined && (await exists(aside))) await rename(aside, dir);
			};
			try {
				// (2) The old directory aside, (3) the new one in place.
				if (aside !== undefined) await rename(dir, aside);
				await rename(staging, dir);
				placed = true;
				// (4) The server's part, the one commit, last.
				const parts = decodeJsonl(createReadStream(join(dir, "server.archive")));
				await this.host.importHostData(parts, context, { address, existing });
			} catch (error) {
				if (unknownOutcome(error)) {
					// It may have committed: undoing could pair the old directory with the new server data.
					throw new Error(
						`importData: ${address.key}: the server's commit has an unknown outcome; nothing was undone (the ` +
							`new directory is in place${aside === undefined ? "" : `, the old one at ${aside}`}). Run the ` +
							`import again with existing: "replace" once the server's store is back.`,
						{ cause: error },
					);
				}
				await undo();
				throw error;
			}
			// Committed: what is left over is harmless, so these never fail the import.
			await rm(join(dir, "server.archive"), { force: true }).catch(() => {});
			if (aside !== undefined) await rm(aside, { recursive: true, force: true }).catch(() => {});
		});
	}

	async deleteData(address: Address, context: Context): Promise<void> {
		this.#workersOf(address);
		const dir = workerDirectory(this.dataDir, address);
		await this.#underLock(address, "deleteData", "runs; stop its worker first", context, async () => {
			// The server's part first (the one commit); a crash before the directory goes leaves it orphaned (nothing
			// refers to it) and a repeated `deleteData` removes it.
			await this.host.deleteHostData(address, context);
			await rm(dir, { recursive: true, force: true });
		});
	}

	/** Runs `work` under the worker's lock of `address` (refused while its worker runs: `<what>: <key> <held>`). */
	async #underLock(
		address: Address,
		what: string,
		held: string,
		context: Context,
		work: () => Promise<void>,
	): Promise<void> {
		const lock = await this.#workerLock(address, context);
		if (lock === undefined) throw new Error(`${what}: ${address.key} ${held}`);
		try {
			await work();
		} finally {
			await lock.release();
		}
	}

	/** The process lock of the worker at `address` (the one its worker takes at start), or `undefined` while held. */
	async #workerLock(address: Address, context: Context): Promise<ProcessLock | undefined> {
		const waited = AbortSignal.timeout(ADDRESS_LOCK_MS);
		try {
			return await processLock(
				workerLock(this.#options.name, this.dataDir, address.key),
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

	/** Whether the app is closing or closed: what runs after the start stops there. */
	closing(): boolean {
		return this.#closing !== undefined;
	}

	/**
	 * The close, in order: HTTP (it drains requests the host's close would seal), workers, host, store, the plugins'
	 * watcher, then the data directory's lock. The bases' builds and the recording of the base code are not waited for:
	 * what they finish after the close is dropped.
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
