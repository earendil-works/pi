// Server host: HTTP + WebSocket accept, routes `session:` hosts to session workers, loads the server facets.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isChordError, localeChoiceFacet, type PluginFacet, webSocketLink } from "@earendil-works/chord";
import { filesFacet } from "@earendil-works/chord/app/files";
import { nodeCompression } from "@earendil-works/chord/compression";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RolloutResult } from "@earendil-works/chord/plugins";
import { webSurface } from "@earendil-works/chord/surfaces";
import { telemetryIngestFacet } from "@earendil-works/chord/telemetry-ingest";
import { WebSocketServer } from "ws";
import { backupConfigured } from "../runtime/backup.ts";
import { type Ctx, createHost, type Host, type HostError, hostErrorText, Server, Session } from "../runtime/chord.ts";
import { envDefaultModel } from "../runtime/default-model.ts";
import { type DevCommand, type DevResult, parseDevCommand } from "../runtime/dev-protocol.ts";
import { configureFetch } from "../runtime/fetch.ts";
import {
	assertMigrated,
	hostFiles,
	openHostStore,
	openTelemetry,
	serverDirectory,
	userPluginsDirectory,
} from "../runtime/host-dirs.ts";
import { fromOrigin, sendJson } from "../runtime/http.ts";
import { captureProcessLogs, processLogs } from "../runtime/logs.ts";
import { mintOwnerLink } from "../runtime/owner-link.ts";
import { signIn } from "../runtime/page.ts";
import { isGuest, isOwner, type P2Principal, principalAttributes, SERVER } from "../runtime/principals.ts";
import { takeProcessLock } from "../runtime/process-lock.ts";
import {
	Authenticators,
	findRoute,
	PageCookies,
	type PluginApply,
	type PluginOutcome,
	type RequestAccess,
	type RequestOrigin,
	RequestResolvers,
	Routes,
	type ServerResourceOptions,
	serverCore,
	Upgrades,
	WorkerInitValues,
} from "../runtime/server.ts";
import { isLinkClient, STALE_PAGE_CODE, STALE_PAGE_REASON } from "../runtime/stale-page.ts";
import { WorkerBoundary, type WorkerInit } from "../runtime/worker.ts";
import { type BundleInput, buildTuiBundle, type TuiBundle, tuiManifest } from "./bundles.ts";
import { devControl } from "./dev.ts";
import { readDevCommand, sendDevCommand, serveDevChannel } from "./dev-channel.ts";
import { LoadedModules, loadedModuleHashes, loadedPluginFiles } from "./dev-modules.ts";
import {
	createP2Plugins,
	listPlugins,
	listRoots,
	type P2Plugins,
	PLUGINS_DIRECTORY,
	SERVER_PACKAGES,
	selectPlugins,
} from "./plugins.ts";
import {
	contentSecurityPolicy,
	foreignBrowserRequest,
	pageNavigation,
	parseAllowedHosts,
	requestOrigin,
	sameOrigin,
} from "./principals.ts";
import { SessionWorkers } from "./session-workers.ts";
import { limitedSocket, MAX_CLIENT_FRAME } from "./socket-limits.ts";
import { tuiPreferencesFacet } from "./tui-preferences.ts";
import { WEB_ENTRY, WEB_RESOLUTION } from "./web/base.ts";
import { createWeb, isAppPage, isPublicFile } from "./web.ts";

/** The p2 app directory (`apps/p2`), told to facets as `Server.info.app` and `WorkerInit.app`. */
const APP = fileURLToPath(new URL("../../", import.meta.url));

export type ServerOptions = {
	/** Exactly these plugins (default: all built-ins). A missing provider fails at activation, naming the consumer. */
	readonly plugins?: readonly string[];
	readonly dataDir?: string;
	readonly port?: number;
	readonly fake?: boolean;
	/** Serve the web UI (default true). */
	readonly web?: boolean;
	/** Server-side TUI source directory override for disposable test facets. Never sent to the launcher. */
	readonly tuiDirectory?: string;
	/** Mark backend/runtime changes dirty and enable explicit dev controls (default P2_DEV=1). */
	readonly dev?: boolean;
	/** Idle time before a session worker stops (default 5 minutes). */
	readonly idleMs?: number;
	/** How long a running worker may take to follow a relocation before it is restarted instead (default 60 s). */
	readonly moveTimeoutMs?: number;
	/** Extra environment for workers. */
	readonly workerEnv?: Readonly<Record<string, string>>;
	/** HTTPS tunnel hosts besides loopback (default `P2_ALLOWED_HOSTS`, comma-separated). */
	readonly allowedHosts?: readonly string[];
	/** Overrides of the server's configuration resources (tests: a fixture provider with login flows). */
	readonly resources?: ServerResourceOptions;
	/** Facets loaded with the core, never reloaded (disposable test probes: their routes and types). */
	readonly facets?: readonly PluginFacet<P2Principal>[];
};

export type P2Server = {
	readonly host: Host;
	readonly port: number;
	readonly dataDir: string;
	/** The server/worker plugin selection (alphabetical). */
	readonly plugins: readonly string[];
	/** Builds plugins and rolls them out to the server and every running worker. */
	reload(plugins: readonly string[]): Promise<RolloutResult>;
	close(): Promise<void>;
};

/** A page's refused link: the base bundle it names (`null`: none, a page from older code) and the server's. */
type StalePage = { readonly sent: string | null; readonly current: string | undefined };

/** Who a principal is, for the owner's notices: the owner's access (and device) or a guest's name and ID. */
function principalText(principal: P2Principal): string {
	switch (principal.kind) {
		case "owner":
			return principal.access === "device"
				? `the owner's device ${principal.device}`
				: `the owner (${principal.access})`;
		case "guest":
			return `guest ${principal.name} (${principal.id})`;
		case "worker":
			return `session ${principal.session}'s worker`;
		default:
			return principal.kind;
	}
}

export async function startServer(options: ServerOptions = {}): Promise<P2Server> {
	// As Pi Mobile: a half-set default model from the environment refuses to start (before taking any lock).
	envDefaultModel();
	const dev = options.dev ?? process.env.P2_DEV === "1";
	const supervised = dev && process.connected && Number(process.env.P2_DEV_SUPERVISOR_PID) === process.ppid;
	const resume: unknown = dev ? JSON.parse(process.env.P2_DEV_RESUME ?? "[]") : [];
	if (!Array.isArray(resume) || !resume.every((id: unknown) => typeof id === "string"))
		throw new Error("Invalid dev resume list");
	const dataDir = options.dataDir ?? process.env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2");
	// The user plugin root (`<data>/plugins/`): created here, so the plugin watcher watches it from the start.
	const userRoot = userPluginsDirectory(dataDir);
	mkdirSync(userRoot, { recursive: true, mode: 0o700 });
	/** Where plugins are found, in order: the built-ins win a name. */
	const roots = [PLUGINS_DIRECTORY, userRoot];
	/**
	 * The selection: every plugin of plugins/, or exactly the requested ones (tests), and every plugin of the user root
	 * whose name no built-in has, alphabetical.
	 */
	const currentSelection = (): string[] => {
		const builtIns = listPlugins(PLUGINS_DIRECTORY);
		const user = [...listPlugins(userRoot).keys()].filter((name) => !builtIns.has(name));
		return [...selectPlugins(builtIns, options.plugins), ...user].sort();
	};
	let plugins = currentSelection();
	const devModules = dev
		? new LoadedModules(loadedModuleHashes, loadedPluginFiles, join(dataDir, "dev-modules"))
		: undefined;
	const fake = options.fake ?? process.env.P2_FAKE === "1";
	mkdirSync(join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
	// The local owner is whoever can read this directory's owner key, and not every file in it is 0600 (SQLite
	// stores, mcp.json): a directory made before p2 (another umask) is made private too.
	chmodSync(dataDir, 0o700);
	// One server per data directory: a lock another server holds refuses the start after a short wait (a restart's old
	// server may still be exiting).
	const unlock = await takeProcessLock(`p2:server:${dataDir}`, 5000).catch((error: unknown) => {
		throw new Error(`Another p2 server uses ${dataDir}`, { cause: error });
	});
	const allowedHosts = options.allowedHosts ?? parseAllowedHosts(process.env.P2_ALLOWED_HOSTS);
	// The server's Chord store (`<data>/server/store.sqlite`): persisted documents, tables and job runs of its
	// host-lifetime objects (the catalog, shares, subagents, session lifecycle operations) and its `Files` index. It keeps
	// an outbox while backup is configured (`src/runtime/backup.ts`), which `plugins/backup` uploads.
	let store: Awaited<ReturnType<typeof openHostStore>>;
	// The telemetry store (`<data>/telemetry.sqlite`, Chord's §29): the server's host records to it, the ingest facet
	// below writes what workers and owner pages send. Always on: Chord's cost (§30), no sampling.
	let telemetry: Awaited<ReturnType<typeof openTelemetry>>;
	try {
		assertMigrated(dataDir);
		telemetry = await openTelemetry(dataDir);
		store = await openHostStore(serverDirectory(dataDir), { outbox: backupConfigured() }, BACKGROUND_CONTEXT).catch(
			async (error: unknown) => {
				await telemetry.close();
				throw error;
			},
		);
	} catch (error) {
		await unlock();
		throw error;
	}
	// The server's own requests act as `SERVER`: a worker tells them from a person's (`WorkerBoundary`).
	const host = createHost({
		address: Server(),
		principal: SERVER,
		store,
		telemetry: telemetry.telemetry,
		principalAttributes,
		// JSON parts above 16 KiB this host originates (snapshots of the catalogs) go deflated: the WebSocket does not
		// compress, and a tunnel carries them as they are.
		compression: nodeCompression,
		onError: (error) => {
			if (isOwnerNotice(error)) processLogs.notice("server", hostErrorText(error));
			console.error("p2 server:", error);
		},
	});
	const p2Plugins = createP2Plugins(
		options.plugins,
		(error) => console.error("p2 plugins:", error),
		BACKGROUND_CONTEXT,
		userRoot,
	);
	const { plugins: chordPlugins } = p2Plugins;
	const serveWeb = options.web ?? true;
	/**
	 * The pages' code (Chord's web surface): the base bundle built from src/hosts/web/entry.ts after the listen, the
	 * plugins' web facets as scripts that apply in place; served by `web.ts` with p2's own access rules (no routes).
	 */
	const surface = serveWeb
		? webSurface(host, { plugins: chordPlugins, entry: WEB_ENTRY, ...WEB_RESOLUTION, routes: false })
		: undefined;
	// Listen first so plugins see the actual port, but capture requests/upgrades BEFORE listening.
	// A reconnect can arrive while plugins load: without an upgrade listener Node treats it as
	// a normal HTTP request, loses it, and leaves the browser waiting forever for its handshake.
	let markLoaded!: () => void;
	const loaded = new Promise<void>((resolve) => {
		markLoaded = resolve;
	});
	const http = createServer();
	http.on("request", (request: IncomingMessage, response: ServerResponse) => {
		void loaded.then(() => handle(request, response));
	});
	http.on("upgrade", (request, socket, head) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		void loaded
			.then(() => upgradePrincipal(request))
			.catch(() => undefined)
			.then(async (principal) => {
				if (path === "/chord" && principal !== undefined) {
					const stale = await stalePage(request);
					if (stale) {
						// Its link would re-hold what its code holds, types removed since included (each waiting on the
						// worker and reported there at every start): it reloads onto the current bundle instead.
						reportStalePage(request, principal, stale);
						sockets.handleUpgrade(request, socket, head, (ws) => ws.close(STALE_PAGE_CODE, STALE_PAGE_REASON));
						return;
					}
					upgraded.set(request, principal);
					sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
				} else if (principal !== undefined) {
					await host.root(async (ctx) => {
						const upgrade = (await host.registry(Upgrades, ctx)).value.get(path);
						if (upgrade) await upgrade(request, socket, head, principal, ctx);
						else socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
					}, BACKGROUND_CONTEXT);
				} else socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			})
			.catch(() => socket.destroy());
	});
	const port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 8788);
	await new Promise<void>((resolve, reject) => {
		http.once("error", reject);
		http.listen(port, "127.0.0.1", () => {
			http.removeListener("error", reject);
			resolve();
		});
	});
	const address = http.address();
	const actualPort = typeof address === "object" && address !== null ? address.port : port;
	const info = { app: APP, dataDir, fake, allowedHosts: [...allowedHosts], port: actualPort };
	const workers = await SessionWorkers.create(
		{
			host,
			plugins: chordPlugins,
			app: APP,
			dataDir,
			fake,
			entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
			// A young generation of at most 2 MiB per semi-space (default 16): V8 grows it to 32 MiB committed during bursts
			// and keeps most of it, about 26 MiB of every worker's private memory; the cap costs a few ms more minor GC
			// per run (measured: 53 minor GCs instead of 14 over a start and a turn, 18-23 ms instead of 15, same CPU).
			execArgv: ["--max-semi-space-size=2", "--import", new URL("../source.ts", import.meta.url).href],
			env: {
				...options.workerEnv,
				...(dev ? { P2_DEV: "1", P2_DEV_MODULE_DIR: join(dataDir, "dev-modules") } : {}),
			},
			...((options.idleMs ?? process.env.P2_IDLE_MS)
				? { idleMs: options.idleMs ?? Number(process.env.P2_IDLE_MS) }
				: {}),
			...(options.moveTimeoutMs === undefined ? {} : { moveTimeoutMs: options.moveTimeoutMs }),
			// Each plugin's part of the start data (the sessions plugin's `session`); a throw refuses the start.
			values: async (session, ctx) => {
				const values: Record<string, unknown> = {};
				for (const [key, contribute] of (await host.registry(WorkerInitValues, ctx)).value)
					values[key] = await contribute(session, ctx);
				if (!values.session) throw new Error("Session parameters unavailable; refusing worker start");
				return values as WorkerInit["values"];
			},
		},
		BACKGROUND_CONTEXT,
	);
	// Every session worker runs the worker base Chord bundled just now (not the files on disk): in dev mode its source
	// files are a restart baseline, compared by content like the server's own modules, with the bytes the build read
	// (a read now could see an edit made since).
	devModules?.set(
		"worker-base",
		[...workers.baseInputs]
			.filter(([file]) => !file.startsWith(PLUGINS_DIRECTORY) && !file.startsWith(userRoot))
			.map(([file, hash]) => ({ file, hash })),
	);
	// Capture before plugin resources open (e.g. provider SDK startup), not only after the logs facet activates.
	const stopLogs = captureProcessLogs("server");
	/** Source files of the last built bundles, by bundle (dev watcher: which plugin saves affect downloaded code). */
	const bundleInputs = new Map<"tui" | "web", readonly string[]>();
	/**
	 * Records a bundle's source files. Plugin files mark their plugin dirty when saved (`loadedFiles` below); in dev mode
	 * the others (browser and TUI runtime code) are compared by content like the server's own modules, so a save asks
	 * for a restart, or the next reload, which rebuilds both bundles.
	 */
	const recordInputs = (bundle: "tui" | "web", inputs: readonly BundleInput[]): void => {
		bundleInputs.set(
			bundle,
			inputs.map(({ file }) => file),
		);
		if (!devModules) return;
		const plugin = (file: string) =>
			file.startsWith(PLUGINS_DIRECTORY) ||
			file.startsWith(userRoot) ||
			(options.tuiDirectory !== undefined && file.startsWith(options.tuiDirectory));
		devModules.set(
			`${bundle}-bundle`,
			inputs.filter(({ file }) => !plugin(file)),
		);
	};
	/** Records a built bundle only once it is current (after a successful reload commit). */
	const adoptTui = (bundle: TuiBundle): void => recordInputs("tui", bundle.inputs);
	// The TUI bundle builds once, on first use, and again only when a plugin reload commits. A late lazy build may not
	// overwrite the input baseline installed by a newer reload.
	let tuiBundle: Promise<TuiBundle> | undefined;
	const getTuiBundle = (): Promise<TuiBundle> => {
		if (tuiBundle) return tuiBundle;
		let current!: Promise<TuiBundle>;
		current = buildTuiBundle(plugins, options.tuiDirectory ?? roots).then(
			(bundle) => {
				if (tuiBundle === current) adoptTui(bundle);
				return bundle;
			},
			(error: unknown) => {
				if (tuiBundle === current) tuiBundle = undefined;
				throw error;
			},
		);
		tuiBundle = current;
		return current;
	};
	const stopDevEvents = dev
		? workers.subscribe(({ session, running, generation, pid }) =>
				process.send?.({
					type: "dev-worker",
					sessionId: session,
					running,
					generation,
					...(pid === undefined ? {} : { pid }),
				}),
			)
		: undefined;
	/** Script nonce of the page CSP (one per server, written into the page's inline scripts). */
	const nonce = randomUUID();
	const web =
		surface === undefined
			? undefined
			: createWeb({ nonce, surface, root: (fn) => host.root(fn, BACKGROUND_CONTEXT) });
	try {
		await chordPlugins.load(
			host,
			{
				kind: "server",
				core: [
					{
						name: "@p2/core",
						facet: serverCore(host, info, {
							resourceOptions: options.resources ?? {},
							workers,
							root: (fn, context) => host.root(fn, context),
							store,
							telemetry: telemetry.telemetry,
							plugins: { root: userRoot, reload: (requested) => applyPlugins(requested) },
						}),
					},
					{ name: "@p2/tui-preferences", facet: tuiPreferencesFacet(dataDir) },
					// The server's files (the kit's `Files`): `<data>/server/files/`.
					{ name: "chord.app.files", facet: filesFacet(hostFiles(serverDirectory(dataDir))) },
					// The pages' code, and the user's locale pick that a page's language follows (Chord's page holds it).
					{
						name: "chord.telemetry",
						facet: telemetryIngestFacet<P2Principal>({
							target: telemetry.telemetry,
							// Owners' pages only: a guest could open page after page (each its own budget).
							admit: isOwner,
							workerHost: (principal) =>
								principal.kind === "worker" ? Session({ id: principal.session }).key : undefined,
							principalAttributes,
						}),
					},
					...(surface === undefined
						? []
						: [
								{ name: "chord.web", facet: surface.facet },
								{ name: "chord.locale.choice", facet: localeChoiceFacet<P2Principal>() },
							]),
					...(options.facets ?? []),
				],
				modules: SERVER_PACKAGES,
			},
			BACKGROUND_CONTEXT,
		);
	} catch (error) {
		processLogs.notice("server", `Server startup failed: ${error instanceof Error ? error.message : String(error)}`);
		await workers.close(BACKGROUND_CONTEXT).catch(() => {});
		await host.close(BACKGROUND_CONTEXT).catch(() => {});
		await telemetry.close().catch(() => {});
		await store.close(BACKGROUND_CONTEXT).catch(() => {});
		p2Plugins.close();
		stopLogs();
		await new Promise<void>((resolve) => http.close(() => resolve()));
		await unlock();
		throw error;
	}

	let reloading = false;
	/**
	 * Builds `requested` (and plugins added since), web facets included, then the TUI bundle of the new selection, then
	 * rolls the build out to the server, every running worker and the pages (the web surface), and adopts the TUI bundle.
	 * Stops before the rollout at the first failed build (a facet's, or the TUI bundle's): nothing changes then.
	 */
	const rebuild = async (requested: readonly string[]): Promise<Rebuilt> => {
		const built = await chordPlugins.build(requested, BACKGROUND_CONTEXT);
		const failed = built.facets.flatMap((facet) =>
			facet.kind === "failed" ? [{ plugin: facet.plugin, kind: facet.facet, errors: facet.errors }] : [],
		);
		if (failed.length) return { kind: "failed", failed };
		const next = currentSelection();
		processLogs.append("server", "event", `Reloading plugins: ${requested.join(", ")}`);
		// Prepare the TUI's downloaded code before the backend commit; publish only a successfully committed selection.
		// Web facets are among `built`: the web surface's step publishes them to pages after the server and workers.
		let nextTuiBundle: TuiBundle;
		try {
			nextTuiBundle = await buildTuiBundle(next, options.tuiDirectory ?? roots);
		} catch (error) {
			return { kind: "failed", failed: bundleFailures(error, roots) };
		}
		const result = await chordPlugins.rollout(
			[
				chordPlugins.step("server", host),
				workers.workers.step("workers"),
				...(surface === undefined ? [] : [surface.step("web")]),
			],
			built,
			BACKGROUND_CONTEXT,
		);
		plugins = next;
		tuiBundle = Promise.resolve(nextTuiBundle);
		adoptTui(nextTuiBundle);
		const changed = [...new Set(built.facets.map((facet) => facet.plugin))].sort();
		for (const notice of processLogs.notices())
			if (notice.source === "server" && notice.message.startsWith("Reload refused:"))
				processLogs.dismissNotice(notice.id);
		processLogs.append("server", "event", `Reloaded plugins: ${changed.join(", ")}`);
		return { kind: "rolled", built, result, changed };
	};
	/**
	 * Builds `requested` (and plugins added since), then rolls them out to the server, every running worker and the
	 * pages; the TUI bundle is rebuilt first (a failed build keeps the old code and bundles). A plugin whose build or
	 * evaluation fails keeps its old code (an added one stays out), reported in the result.
	 */
	const performReload = async (
		requested: readonly string[],
	): Promise<{ plugins: readonly string[]; value: RolloutResult }> => {
		if (reloading) throw new Error("A p2 plugin reload is already running");
		reloading = true;
		try {
			const listing = listRoots(roots);
			const next = currentSelection();
			// A loaded plugin whose directory is gone is removed by the reload.
			for (const name of requested) {
				if (next.includes(name) || (plugins.includes(name) && !listing.has(name))) continue;
				throw new Error(
					listing.has(name) ? `Cannot reload unloaded p2 plugin: ${name}` : `Unknown p2 plugin: ${name}`,
				);
			}
			const rebuilt = await rebuild(requested);
			if (rebuilt.kind === "failed")
				throw new Error(
					rebuilt.failed.map((facet) => `${facet.plugin} (${facet.kind}): ${facet.errors.join("; ")}`).join(". "),
				);
			return { plugins: rebuilt.changed, value: rebuilt.result };
		} catch (error) {
			processLogs.notice("server", `Reload refused: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		} finally {
			reloading = false;
		}
	};
	/**
	 * Reloads plugins for `reload_plugins` (any root): `requested`, else every dirty plugin, every plugin of the user
	 * root and every loaded plugin no longer on disk (an unchanged one keeps its digest, so its hosts keep it as it is).
	 * Named plugins are discovered again when the watcher has not reported their change yet (`Plugins.build`), so an
	 * agent's apply never depends on the watcher's timing: a plugin written just before is applied, one deleted just
	 * before is removed. Says per plugin what happened: applied, removed, failed with the build's or
	 * the hosts' errors (a failed build applies nothing), or refused (unknown, or an invalid package); and the errors
	 * logged meanwhile.
	 */
	const applyPlugins = async (requested?: readonly string[]): Promise<PluginApply> => {
		if (reloading)
			return { refused: "Another plugin reload is running; try again in a moment.", plugins: [], logs: [] };
		reloading = true;
		const since = Date.now();
		try {
			const listed = listRoots(roots);
			const builtIns = listPlugins(PLUGINS_DIRECTORY);
			const state = chordPlugins.state.value;
			const wanted =
				requested ??
				[
					...new Set([
						...state.dirty,
						...state.install,
						...[...listPlugins(userRoot).keys()].filter((name) => !builtIns.has(name)),
						...plugins.filter((name) => !listed.has(name)),
					]),
				].sort();
			const unknown = wanted.filter((name) => !listed.has(name) && !plugins.includes(name));
			const names = wanted.filter((name) => !unknown.includes(name));
			const rebuilt = await rebuild(names);
			// After the build, which discovered the roots anew.
			const refusals = [
				...unknown.map((plugin) => ({ plugin, outcome: "refused" as const, errors: ["No such plugin"] })),
				...(await discoveryProblems()),
			];
			const result: PluginApply =
				rebuilt.kind === "failed"
					? {
							plugins: [
								...rebuilt.failed.map(({ plugin, kind, errors }) => ({
									plugin,
									outcome: "failed" as const,
									errors: errors.map((error) => `${kind}: ${error}`),
								})),
								...refusals,
							],
							logs: [],
						}
					: { plugins: [...rolledOutcomes(rebuilt), ...refusals], logs: [] };
			watcher?.notify({
				ok: result.plugins.every((each) => each.outcome === "applied" || each.outcome === "removed"),
				message: result.plugins.map((each) => `${each.plugin}: ${each.outcome}`).join(", ") || "No dirty plugins",
				plugins: result.plugins.map((each) => each.plugin),
			});
			return { ...result, logs: recentErrors(since) };
		} finally {
			reloading = false;
		}
	};
	/** A rollout's outcome per plugin: applied, removed, or failed with the hosts' errors. */
	const rolledOutcomes = (rebuilt: Extract<Rebuilt, { kind: "rolled" }>): PluginOutcome[] => {
		const hostFailures = new Map<string, string[]>();
		const fail = (plugin: string, text: string) =>
			hostFailures.set(plugin, [...(hostFailures.get(plugin) ?? []), text]);
		for (const step of rebuilt.result.steps)
			for (const each of step.hosts) {
				if ("report" in each)
					for (const { plugin, error } of each.report.failed) fail(plugin, `${each.host}: ${errorText(error)}`);
				else if ("error" in each)
					for (const plugin of rebuilt.changed) fail(plugin, `${each.host}: ${errorText(each.error)}`);
			}
		return [
			...Object.keys(rebuilt.built.plugins).map((plugin) => {
				const errors = hostFailures.get(plugin);
				return errors ? { plugin, outcome: "failed" as const, errors } : { plugin, outcome: "applied" as const };
			}),
			...rebuilt.built.removed.map((plugin) => ({ plugin, outcome: "removed" as const })),
		];
	};
	/** Discovery's problems (an invalid or missing `package.json`, a name another root has), as refusals. */
	const discoveryProblems = async (): Promise<PluginOutcome[]> => {
		const reals = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
		return chordPlugins.discovery.problems.map((problem) => {
			const root = reals.find((each) => problem.path.startsWith(each + sep));
			return {
				plugin: root === undefined ? problem.path : relative(root, problem.path).split(sep)[0] || problem.path,
				outcome: "refused" as const,
				errors: [problem.error],
			};
		});
	};
	const watcher = dev
		? devControl({
				plugins: chordPlugins,
				reload: performReload,
				runtimeDirectory: APP,
				loadedModules: devModules,
				setChanges: () => {
					const next = currentSelection();
					return [
						...next.filter((name) => !plugins.includes(name)),
						...plugins.filter((name) => !next.includes(name)),
					];
				},
			})
		: undefined;
	const reload = async (requested: readonly string[]): Promise<RolloutResult> =>
		watcher ? watcher.reload(requested) : (await performReload(requested)).value;
	const execute = async (command: DevCommand): Promise<DevResult> => {
		if (!watcher) return { ok: false, message: "Dev mode is not enabled" };
		try {
			if (command.action === "restart") {
				if (!supervised) throw new Error("Restart needs the npm run dev supervisor");
				return await sendDevCommand(dataDir, command);
			}
			await watcher.reload(command.plugins);
			const state = watcher.status();
			return { ok: true, message: state.message ?? "Reloaded", plugins: state.plugins };
		} catch (error) {
			if (command.action === "restart")
				watcher.notify({
					ok: false,
					message: `Restart refused: ${error instanceof Error ? error.message : String(error)}`,
				});
			return { ok: false, message: watcher.status().message ?? String(error) };
		}
	};
	const onDevMessage = (message: unknown): void => {
		if (!supervised || !message || typeof message !== "object" || !("type" in message)) return;
		if (message.type === "dev-command" && "id" in message && typeof message.id === "number" && "command" in message) {
			const id = message.id;
			void (async () => {
				let result: DevResult;
				try {
					result = await execute(parseDevCommand(message.command));
				} catch (error) {
					result = { ok: false, message: String(error) };
				}
				process.send?.({ type: "dev-result", id, result });
			})();
		} else if (message.type === "dev-notice" && "result" in message) {
			const result = message.result;
			if (
				result &&
				typeof result === "object" &&
				"ok" in result &&
				typeof result.ok === "boolean" &&
				"message" in result &&
				typeof result.message === "string"
			)
				watcher?.notify({ ok: result.ok, message: result.message });
		}
	};
	process.on("message", onDevMessage);
	const closeDevChannel = dev && !supervised ? await serveDevChannel(dataDir, execute) : undefined;

	/**
	 * Who sent a request: an owner session cookie (a local one only on loopback), a guest cookie, a Radius user. An owner
	 * wins over a guest cookie in the same browser. Loopback alone proves nothing (any user of the machine reaches it):
	 * the local owner is whoever proved to run as the server's user (`src/runtime/local-owner.ts`) or redeemed an owner
	 * link on loopback, and holds that local session cookie. Another site's requests lose every principal in
	 * `resolveAccess`.
	 */
	const authenticate = async (
		request: IncomingMessage,
		origin: RequestOrigin,
		ctx: Ctx,
	): Promise<P2Principal | undefined> => {
		let authenticated: P2Principal | undefined;
		for (const authenticator of (await host.registry(Authenticators, ctx)).value.values()) {
			const principal = await authenticator(request, origin, ctx);
			if (isOwner(principal)) return principal;
			authenticated ??= principal;
		}
		return authenticated;
	};
	const credentialAccess = async (request: IncomingMessage, ctx: Ctx): Promise<RequestAccess | undefined> => {
		for (const resolve of (await host.registry(RequestResolvers, ctx)).value.values()) {
			const access = resolve(request, ctx);
			if (access?.principal === undefined && access?.origin.relayUser !== undefined)
				return { principal: await authenticate(request, access.origin, ctx), origin: access.origin };
			if (access !== undefined) return access;
		}
		const origin = requestOrigin(request, allowedHosts);
		if (origin === undefined) return undefined;
		return { principal: await authenticate(request, origin, ctx), origin };
	};
	/**
	 * A browser request another site made (Fetch Metadata: cross-site, or same-site such as a page on another local
	 * port, whose cookies SameSite does not separate) gets no principal from any credential: no fetch, module, upload
	 * or WebSocket of a foreign page can read or drive p2 with the owner's or a guest's cookie. Only a top-level
	 * navigation to an app page authenticates, so links into p2 open it normally. Radius-relayed requests are
	 * authenticated per channel by Radius (and framed by its shell), not by browser cookies; requests without Fetch
	 * Metadata (the TUI, scripts) are unaffected.
	 */
	const resolveAccess = async (request: IncomingMessage, ctx: Ctx): Promise<RequestAccess | undefined> => {
		const access = await credentialAccess(request, ctx);
		if (
			access?.principal !== undefined &&
			access.origin.relayShellOrigin === undefined &&
			foreignBrowserRequest(request) &&
			!pageNavigation(request)
		)
			return { ...access, principal: undefined };
		return access;
	};
	const handle = (request: IncomingMessage, response: ServerResponse): void => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		// Nothing frames the app (a response with its own CSP, e.g. an artifact preview, sets its own frame-ancestors).
		response.setHeader("Content-Security-Policy", contentSecurityPolicy(nonce, undefined));
		response.setHeader("X-Frame-Options", "DENY");
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		void host
			.root(async (ctx) => {
				const access = await resolveAccess(request, ctx);
				if (access !== undefined) {
					response.setHeader("Content-Security-Policy", contentSecurityPolicy(nonce, access.origin));
					// The Radius shell frames the relayed UI; X-Frame-Options cannot name another origin.
					if (access.origin.relayShellOrigin !== undefined) response.removeHeader("X-Frame-Options");
				}
				if (access === undefined || !sameOrigin(request, access.origin)) {
					response.writeHead(403, { "Content-Type": "text/plain" });
					response.end(access === undefined ? "Localhost only" : "Invalid origin");
					return;
				}
				const { principal, origin } = access;
				// Unauthenticated readiness (Pi Mobile's /health, polled by launchers); known Hosts only.
				if (path === "/health" && (request.method === "GET" || request.method === "HEAD")) {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true, name: "p2" }));
					return;
				}
				// The installable app's public files (web.ts `PUBLIC_FILES`), for home screens that fetch them without
				// cookies (same-origin, or without browser site headers). Not for another site's page: an image there
				// loading p2's icon would tell it a p2 runs at that address (on localhost above all).
				if (
					web !== undefined &&
					isPublicFile(path) &&
					(request.method === "GET" || request.method === "HEAD") &&
					!foreignBrowserRequest(request)
				)
					return web.handle(request, response);
				if (path === "/__p2_dev") {
					if (!isOwner(principal) || (request.method === "POST" && !fromOrigin(request, origin))) {
						response.writeHead(403);
						response.end();
					} else if (request.method === "POST") {
						try {
							const command = await readDevCommand(request);
							// A supervised restart stops this server before the supervisor answers, which cancels this request
							// (the client saw an empty 500). Answer first; the outcome arrives as the supervisor's dev notice.
							if (command.action === "restart" && watcher && supervised) {
								sendJson(response, 202, { ok: true, message: "Restarting server" });
								void execute(command);
								return;
							}
							const result = await execute(command);
							sendJson(response, result.ok ? 200 : 409, result);
						} catch (error) {
							sendJson(response, 400, { ok: false, message: String(error) });
						}
					} else {
						sendJson(response, 200, watcher ? { ...watcher.status(), hasLogs: plugins.includes("logs") } : null);
					}
					return;
				}
				if (path === "/__p2_tui" || /^\/__p2_tui\/[a-f0-9]{64}\.mjs$/.test(path)) {
					if (
						(isOwner(principal) || isGuest(principal)) &&
						(request.method === "GET" || request.method === "HEAD")
					) {
						const bundle = await getTuiBundle();
						const tui = tuiManifest(bundle);
						if (path !== "/__p2_tui" && path !== tui.bundle) {
							response.writeHead(404);
							response.end();
							return;
						}
						const manifest = path === "/__p2_tui";
						response.writeHead(200, {
							"Content-Type": manifest ? "application/json" : "text/javascript; charset=utf-8",
						});
						response.end(request.method === "HEAD" ? undefined : manifest ? JSON.stringify(tui) : bundle.source);
						return;
					}
					if (isGuest(principal)) {
						response.writeHead(403);
						response.end();
					} else signIn(request, response, 401);
					return;
				}
				const route = findRoute((await host.registry(Routes, ctx)).value, request.method ?? "GET", path);
				if (route !== undefined) return route(request, response, { principal, origin }, ctx);
				// An owner loading the app may get renewed cookies (a local session in use does not expire).
				if (isOwner(principal) && (request.method === "GET" || request.method === "HEAD") && isAppPage(path)) {
					const cookies = [...(await host.registry(PageCookies, ctx)).value.values()].flatMap(
						(cookie) => cookie(request, { principal, origin }) ?? [],
					);
					if (cookies.length) response.setHeader("Set-Cookie", cookies);
				}
				if (isOwner(principal) || (isGuest(principal) && (await web?.guestMayLoad(request, principal)))) {
					if (web !== undefined)
						return web.handle(request, response, { principal, shellOrigin: origin.relayShellOrigin });
					response.writeHead(404, { "Content-Type": "text/plain" });
					response.end("Not found");
					return;
				}
				if (isGuest(principal)) {
					response.writeHead(403, { "Content-Type": "text/plain" });
					response.end("Forbidden");
					return;
				}
				request.resume();
				// A Radius user is signed in already; owner sign-in is not for them.
				if (origin.relayUser !== undefined) {
					response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
					response.end("Nothing on this brain is shared with you. Ask its owner for a share link.\n");
					return;
				}
				// A link from another site may arrive without the owner's cookie (Chrome launching an installed app sent
				// none): the page loads itself once more from this origin, which sends it.
				signIn(request, response, 401, { reload: foreignBrowserRequest(request) && pageNavigation(request) });
			}, BACKGROUND_CONTEXT)
			.catch((error: unknown) => {
				console.error("p2 server: request failed", error);
				if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
				response.end();
			});
	};
	const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME, perMessageDeflate: false });
	/** The principal of an upgrade request, or undefined to refuse it. */
	const upgradePrincipal = async (request: IncomingMessage): Promise<P2Principal | undefined> => {
		return host.root(async (ctx) => {
			const access = await resolveAccess(request, ctx);
			return access !== undefined && sameOrigin(request, access.origin) ? access.principal : undefined;
		}, BACKGROUND_CONTEXT);
	};
	const upgraded = new WeakMap<IncomingMessage, P2Principal>();
	/**
	 * A page's link from code other than the current: its `web` query names another base bundle, or it names neither a
	 * base nor a client (`client`: the TUI, Cloud Brain's pages, scripts), a page from before pages named their base
	 * (src/runtime/stale-page.ts). Without the web surface no page is served here and none is asked.
	 */
	const stalePage = async (request: IncomingMessage): Promise<StalePage | undefined> => {
		const query = new URL(request.url ?? "/", "http://localhost").searchParams;
		const sent = query.get("web");
		if (surface === undefined || (sent === null && isLinkClient(query.get("client")))) return undefined;
		const current = await surface.base();
		if (sent === null) return { sent, current };
		return current !== undefined && sent !== current ? { sent, current } : undefined;
	};
	/** Stale pages already reported, by who and which version: each is told the owner once per server run. */
	const staleReported = new Set<string>();
	const reportStalePage = (request: IncomingMessage, principal: P2Principal, { sent, current }: StalePage): void => {
		const who = principalText(principal);
		const agent = String(request.headers["user-agent"] ?? "unknown browser").slice(0, 200);
		const text = `A page running an older p2 (web bundle ${sent ?? "unnamed: from before 2026-11-12"}, current ${current ?? "not built"}) tried to connect and was told to reload: ${who}, ${agent}, from ${request.socket.remoteAddress ?? "unknown address"} (WebSocket /chord).`;
		const key = `${who}\n${agent}\n${sent}`;
		if (staleReported.has(key)) return;
		staleReported.add(key);
		processLogs.notice("stale-pages", text);
	};
	// Mobile's limits: frames up to 1 MiB, 4 MiB unsent output (socket-limits.ts); Chord queues calls behind its window.
	sockets.on("connection", (socket, request: IncomingMessage) => {
		const principal = upgraded.get(request);
		if (principal === undefined) return socket.terminate();
		host.accept(
			webSocketLink(limitedSocket(socket)),
			{ principal, limits: { part: MAX_CLIENT_FRAME } },
			BACKGROUND_CONTEXT,
		);
	});
	if (dev) {
		// A dev restart restores the workers that ran before, viewed or not (their Durable work resumes there).
		for (const session of resume)
			void host
				.get(WorkerBoundary, { session }, BACKGROUND_CONTEXT)
				.then((boundary) => boundary.release())
				.catch((error: unknown) => {
					console.error(`p2 dev: cannot resume ${session}:`, error);
					process.send?.({ type: "dev-worker", sessionId: session, running: false });
				});
	}
	// Build the pages' base bundle in the background, so the first page load rarely waits for it; its files are the
	// web's base code (a save of one asks for a restart in dev mode).
	void surface?.build().then((built) => {
		if (built.kind === "built")
			recordInputs(
				"web",
				// Packages change by an install, which restarts anyway (the old bundle recorded none either).
				[...built.inputs].flatMap(([file, hash]) => (file.includes("/node_modules/") ? [] : [{ file, hash }])),
			);
		else
			processLogs.notice(
				"server",
				`Web UI build failed: ${built.error instanceof Error ? built.error.message : String(built.error)}`,
			);
	});
	markLoaded();
	if (supervised) process.send?.({ type: "dev-ready" });
	let closing: Promise<void> | undefined;
	return {
		host,
		port: actualPort,
		dataDir,
		get plugins() {
			return plugins;
		},
		reload,
		close: () => {
			closing ??= (async () => {
				process.off("message", onDevMessage);
				await closeDevChannel?.();
				await watcher?.close();
				stopDevEvents?.();
				for (const client of sockets.clients) client.terminate();
				await new Promise<void>((resolve) => sockets.close(() => resolve()));
				// Workers send their last spans while closing, the host records its own: the store drains after both.
				await workers.close(BACKGROUND_CONTEXT);
				await host.close(BACKGROUND_CONTEXT);
				await telemetry.close();
				await store.close(BACKGROUND_CONTEXT);
				p2Plugins.close();
				stopLogs();
				http.closeAllConnections();
				await new Promise<void>((resolve) => http.close(() => resolve()));
				await unlock();
			})();
			return closing;
		},
	};
}

/** What a rebuild did: stopped at failed builds, or rolled out (its build, the rollout, the plugins it changed). */
type Rebuilt =
	| {
			readonly kind: "failed";
			readonly failed: readonly { plugin: string; kind: string; errors: readonly string[] }[];
	  }
	| {
			readonly kind: "rolled";
			readonly built: Awaited<ReturnType<P2Plugins["plugins"]["build"]>>;
			readonly result: RolloutResult;
			readonly changed: readonly string[];
	  };

/** A bundle build's failure as failed facets: esbuild's errors with their files and lines, by plugin where it can tell. */
function bundleFailures(
	error: unknown,
	roots: readonly string[],
): { plugin: string; kind: string; errors: string[] }[] {
	// esbuild's build failure (its `errors`); anything else is one message.
	const messages = (
		error as { errors?: { text: string; location?: { file: string; line: number; column: number } | null }[] }
	).errors;
	if (!Array.isArray(messages)) return [{ plugin: "bundle", kind: "web", errors: [errorText(error)] }];
	const byPlugin = new Map<string, string[]>();
	for (const { text, location } of messages) {
		const file = location ? resolve(APP, location.file) : undefined;
		const root = roots.find((each) => file?.startsWith(`${each}${sep}`));
		// A plugin's file is named from its root (`counter/web.tsx`), as the plugin tools name it.
		const path = file && root ? relative(root, file) : location?.file;
		const plugin = path && root ? (path.split(sep)[0] ?? "bundle") : "bundle";
		const where = location ? `${path}:${location.line}:${location.column}: ` : "";
		byPlugin.set(plugin, [...(byPlugin.get(plugin) ?? []), `${where}${text}`]);
	}
	return [...byPlugin].map(([plugin, errors]) => ({ plugin, kind: "web", errors }));
}

/** An error's message. */
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Error lines of the server's and the workers' logs since `since` (the last few). */
function recentErrors(since: number): string[] {
	const lines: { time: number; text: string }[] = [];
	for (const { id } of processLogs.sources())
		for (const line of processLogs.lines(id))
			if (line.time >= since && (line.level === "error" || line.level === "stderr"))
				lines.push({ time: line.time, text: `${id}: ${line.text}` });
	return lines
		.sort((a, b) => a.time - b.time)
		.slice(-20)
		.map((line) => line.text.slice(0, 2000));
}

/**
 * Whether a server host error is an owner notice: not an object that ended, a hold its factory refused (`forbidden`:
 * the caller is told) or a worker's start (the session's own notice has it).
 */
function isOwnerNotice(error: HostError): boolean {
	if (error.kind === "resolve_failed") return false;
	const failure = "error" in error ? error.error : "failure" in error ? error.failure.error : undefined;
	return !isChordError(failure, "released") && !isChordError(failure, "forbidden");
}

/** How long a signalled server may take to close before it exits anyway (below `scripts/dev.mjs`'s 10 s SIGKILL). */
const CLOSE_DEADLINE_MS = 8000;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// Provider logins and server plugins (e.g. the Radius gateway) fetch in this process too.
	configureFetch();
	const server = await startServer();
	const local = new URL(`http://127.0.0.1:${server.port}`);
	console.log(`p2: ${local.origin} (data ${server.dataDir})`);
	// A browser on this machine signs in once per profile by pasting this one-time token into the sign-in page (ten
	// minutes; later ones: npm run owner-link). It is redacted from the server's log buffer; only the terminal shows it.
	await mintOwnerLink(local, server.dataDir, local).then(
		(link) => {
			const token = link.hash.slice(1);
			processLogs.redactor.addSecret(token);
			console.log(`p2: sign-in token (one use, ten minutes; paste it at ${local.origin}): ${token}`);
		},
		(error: unknown) => console.error(`p2: no sign-in token: ${error instanceof Error ? error.message : error}`),
	);
	// Every way out goes through `process.exit`: a signal's default action skips the exit hooks, which remove the
	// macOS lock socket file (else the next start refuses) and kill the MCP servers' process groups.
	let stopping = false;
	const stop = (signal: NodeJS.Signals): void => {
		if (stopping) {
			console.error(`p2: ${signal} again, exiting without finishing the close`);
			process.exit(1);
		}
		stopping = true;
		setTimeout(() => {
			console.error(`p2: the close did not finish within ${CLOSE_DEADLINE_MS / 1000} s, exiting`);
			process.exit(1);
		}, CLOSE_DEADLINE_MS).unref();
		void server.close().finally(() => process.exit(0));
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => stop(signal));
}
