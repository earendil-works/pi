// Server host: HTTP + WebSocket accept, routes `session:` hosts to session workers, loads the server facets.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isChordError, type PluginFacet, webSocketLink } from "@earendil-works/chord";
import { filesFacet } from "@earendil-works/chord/app/files";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RolloutResult } from "@earendil-works/chord/plugins";
import { WebSocketServer } from "ws";
import { type Ctx, createHost, type Host, type HostError, hostErrorText, Server } from "../runtime/chord.ts";
import { envDefaultModel } from "../runtime/default-model.ts";
import { type DevCommand, type DevResult, parseDevCommand } from "../runtime/dev-protocol.ts";
import { configureFetch } from "../runtime/fetch.ts";
import { assertMigrated, hostFiles, openHostStore, serverDirectory } from "../runtime/host-dirs.ts";
import { fromOrigin, sendJson } from "../runtime/http.ts";
import { captureProcessLogs, processLogs } from "../runtime/logs.ts";
import { mintOwnerLink } from "../runtime/owner-link.ts";
import { signIn } from "../runtime/page.ts";
import { isGuest, isOwner, type P2Principal, SERVER } from "../runtime/principals.ts";
import { takeProcessLock } from "../runtime/process-lock.ts";
import {
	Authenticators,
	findRoute,
	PageCookies,
	type RequestAccess,
	type RequestOrigin,
	RequestResolvers,
	Routes,
	type ServerResourceOptions,
	serverCore,
	Upgrades,
	WorkerInitValues,
} from "../runtime/server.ts";
import { WorkerBoundary, type WorkerInit } from "../runtime/worker.ts";
import {
	type BundleInput,
	buildTuiBundle,
	buildWebBundle,
	type TuiBundle,
	tuiManifest,
	type WebBundle,
} from "./bundles.ts";
import { devControl } from "./dev.ts";
import { readDevCommand, sendDevCommand, serveDevChannel } from "./dev-channel.ts";
import { LoadedModules, loadedModuleHashes, loadedPluginFiles } from "./dev-modules.ts";
import { createP2Plugins, listPlugins, PLUGINS_DIRECTORY, SERVER_PACKAGES, selectPlugins } from "./plugins.ts";
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
import { createWeb, isPublicFile } from "./web.ts";

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

/** Old content-named files remain briefly so HTML returned just before a reload can finish loading. */
const WEB_BUNDLE_GRACE_MS = 60_000;

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

export async function startServer(options: ServerOptions = {}): Promise<P2Server> {
	// As Pi Mobile: a half-set default model from the environment refuses to start (before taking any lock).
	envDefaultModel();
	const dev = options.dev ?? process.env.P2_DEV === "1";
	const supervised = dev && process.connected && Number(process.env.P2_DEV_SUPERVISOR_PID) === process.ppid;
	const resume: unknown = dev ? JSON.parse(process.env.P2_DEV_RESUME ?? "[]") : [];
	if (!Array.isArray(resume) || !resume.every((id: unknown) => typeof id === "string"))
		throw new Error("Invalid dev resume list");
	// The selection: every plugin of plugins/, or exactly the requested ones (tests).
	let plugins = selectPlugins(listPlugins(PLUGINS_DIRECTORY), options.plugins);
	const dataDir = options.dataDir ?? process.env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2");
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
	// The server's Chord store (`<data>/server/store.sqlite`): persisted documents and job runs of its host-lifetime
	// objects (session lifecycle operations, search rebuilds) and its `Files` index. Its outbox stays off: local-only
	// data never goes to a sync. p2's older SQLite files stay their owners' natives.
	let store: Awaited<ReturnType<typeof openHostStore>>;
	try {
		assertMigrated(dataDir);
		store = await openHostStore(serverDirectory(dataDir), { outbox: false }, BACKGROUND_CONTEXT);
	} catch (error) {
		await unlock();
		throw error;
	}
	// The server's own requests act as `SERVER`: a worker tells them from a person's (`WorkerBoundary`).
	const host = createHost({
		address: Server(),
		principal: SERVER,
		store,
		onError: (error) => {
			if (isOwnerNotice(error)) processLogs.notice("server", hostErrorText(error));
			console.error("p2 server:", error);
		},
	});
	const p2Plugins = createP2Plugins(options.plugins, (error) => console.error("p2 plugins:", error));
	const { plugins: chordPlugins } = p2Plugins;
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
			execArgv: ["--import", new URL("../source.ts", import.meta.url).href],
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
			.filter(([file]) => !file.startsWith(PLUGINS_DIRECTORY))
			.map(([file, hash]) => ({ file, hash })),
	);
	// Capture before plugin resources open (e.g. provider SDK startup), not only after the logs facet activates.
	const stopLogs = captureProcessLogs("server");
	const serveWeb = options.web ?? true;
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
			(options.tuiDirectory !== undefined && file.startsWith(options.tuiDirectory));
		devModules.set(
			`${bundle}-bundle`,
			inputs.filter(({ file }) => !plugin(file)),
		);
	};
	/** Records a built bundle only once it is current (after a successful reload commit). */
	const adoptTui = (bundle: TuiBundle): void => recordInputs("tui", bundle.inputs);
	const adoptWeb = (bundle: WebBundle): void => recordInputs("web", bundle.inputs);
	// Both bundles build once, on first use, and again only when a plugin reload commits. A late lazy build may not
	// overwrite the input baseline installed by a newer reload.
	let tuiBundle: Promise<TuiBundle> | undefined;
	const getTuiBundle = (): Promise<TuiBundle> => {
		if (tuiBundle) return tuiBundle;
		let current!: Promise<TuiBundle>;
		current = buildTuiBundle(plugins, options.tuiDirectory).then(
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
	let webBundle: Promise<WebBundle> | undefined;
	const retainedWebBundles: { readonly bundle: Promise<WebBundle>; readonly expires: number }[] = [];
	const getWebBundle = (): Promise<WebBundle> => {
		if (webBundle) return webBundle;
		let current!: Promise<WebBundle>;
		current = buildWebBundle(plugins).then(
			(bundle) => {
				if (webBundle === current) adoptWeb(bundle);
				return bundle;
			},
			(error: unknown) => {
				if (webBundle === current) webBundle = undefined;
				throw error;
			},
		);
		webBundle = current;
		return current;
	};
	const previousWebBundles = async (): Promise<readonly WebBundle[]> => {
		const now = Date.now();
		for (let index = retainedWebBundles.length - 1; index >= 0; index--)
			if (retainedWebBundles[index]!.expires <= now) retainedWebBundles.splice(index, 1);
		const settled = await Promise.allSettled(retainedWebBundles.map(({ bundle }) => bundle));
		return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
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
	const web = serveWeb ? createWeb({ nonce, bundle: getWebBundle, previousBundles: previousWebBundles }) : undefined;
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
						}),
					},
					{ name: "@p2/tui-preferences", facet: tuiPreferencesFacet(dataDir) },
					// The server's files (the kit's `Files`): `<data>/server/files/`.
					{ name: "chord.app.files", facet: filesFacet(hostFiles(serverDirectory(dataDir))) },
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
		await store.close(BACKGROUND_CONTEXT).catch(() => {});
		p2Plugins.close();
		stopLogs();
		await new Promise<void>((resolve) => http.close(() => resolve()));
		await unlock();
		throw error;
	}

	let reloading = false;
	/**
	 * Builds `requested` (and plugins added since), then rolls them out to the server and every running worker; the TUI
	 * and web bundles are rebuilt first (a failed build keeps the old code and bundles). A plugin whose build or
	 * evaluation fails keeps its old code (an added one stays out), reported in the result.
	 */
	const performReload = async (
		requested: readonly string[],
	): Promise<{ plugins: readonly string[]; value: RolloutResult }> => {
		if (reloading) throw new Error("A p2 plugin reload is already running");
		reloading = true;
		try {
			const listing = listPlugins(PLUGINS_DIRECTORY);
			const next = selectPlugins(listing, options.plugins);
			// A loaded plugin whose directory is gone is removed by the reload.
			for (const name of requested) {
				if (next.includes(name) || (plugins.includes(name) && !listing.has(name))) continue;
				throw new Error(
					listing.has(name) ? `Cannot reload unloaded p2 plugin: ${name}` : `Unknown p2 plugin: ${name}`,
				);
			}
			const built = await chordPlugins.build(requested, BACKGROUND_CONTEXT);
			const failed = built.facets.filter((facet) => facet.kind === "failed");
			if (failed.length)
				throw new Error(
					failed
						.map(
							(facet) =>
								`${facet.plugin} (${facet.facet}): ${facet.kind === "failed" ? facet.errors.join("; ") : ""}`,
						)
						.join(". "),
				);
			processLogs.append("server", "event", `Reloading plugins: ${requested.join(", ")}`);
			// Prepare downloaded code before the backend commit; publish only a successfully committed selection.
			const nextTuiBundle = await buildTuiBundle(next, options.tuiDirectory);
			const nextWebBundle = serveWeb ? await buildWebBundle(next) : undefined;
			const result = await chordPlugins.rollout(
				[chordPlugins.step("server", host), workers.workers.step("workers")],
				built,
				BACKGROUND_CONTEXT,
			);
			plugins = next;
			tuiBundle = Promise.resolve(nextTuiBundle);
			adoptTui(nextTuiBundle);
			if (nextWebBundle) {
				if (webBundle) {
					retainedWebBundles.unshift({ bundle: webBundle, expires: Date.now() + WEB_BUNDLE_GRACE_MS });
					retainedWebBundles.splice(2);
				}
				webBundle = Promise.resolve(nextWebBundle);
				adoptWeb(nextWebBundle);
			}
			const changed = [...new Set(built.facets.map((facet) => facet.plugin))].sort();
			for (const notice of processLogs.notices())
				if (notice.source === "server" && notice.message.startsWith("Reload refused:"))
					processLogs.dismissNotice(notice.id);
			processLogs.append("server", "event", `Reloaded plugins: ${changed.join(", ")}`);
			return { plugins: changed, value: result };
		} catch (error) {
			processLogs.notice("server", `Reload refused: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		} finally {
			reloading = false;
		}
	};
	const watcher = dev
		? devControl({
				plugins: chordPlugins,
				reload: performReload,
				runtimeDirectory: APP,
				loadedModules: devModules,
				setChanges: () => {
					const next = selectPlugins(listPlugins(PLUGINS_DIRECTORY), options.plugins);
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
							const result = await execute(await readDevCommand(request));
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
				if (
					isOwner(principal) &&
					(request.method === "GET" || request.method === "HEAD") &&
					(path === "/" || path.startsWith("/s/"))
				) {
					const cookies = [...(await host.registry(PageCookies, ctx)).value.values()].flatMap(
						(cookie) => cookie(request, { principal, origin }) ?? [],
					);
					if (cookies.length) response.setHeader("Set-Cookie", cookies);
				}
				if (isOwner(principal) || (isGuest(principal) && (await web?.guestMayLoad(request, principal)))) {
					if (web !== undefined) return web.handle(request, response);
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
	// Build the web UI in the background, so the first page load rarely waits for it. A superseded lazy build neither
	// changes the current baseline nor reports a stale failure after a newer reload committed.
	if (serveWeb) {
		const startupWebBundle = getWebBundle();
		void startupWebBundle.catch((error: unknown) => {
			if (webBundle === undefined || webBundle === startupWebBundle)
				processLogs.notice(
					"server",
					`Web UI build failed: ${error instanceof Error ? error.message : String(error)}`,
				);
		});
	}
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
				await workers.close(BACKGROUND_CONTEXT);
				await host.close(BACKGROUND_CONTEXT);
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
