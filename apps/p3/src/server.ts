// The p3 server's bootstrap: everything that must exist before plugins can load, and nothing else. The data
// directory's socket (`server.sock`, `local-socket.ts`) is taken first: it is the server's lock, and it answers the
// command (what the server is, with its workers' pids, and the plugins' `ServerCommands`). Then the store, the host,
// Chord's HTTP and plugins components, the route to session workers, the base's registries and the runner it uses (the
// one runner with the plugins' wraps composed over it). A failed store (`storage_failed`) ends the server: the host
// closed itself, so it closes and exits non-zero for the supervisor to start it again. The close releases the socket
// last, after the store's close. The base's facet and the route's admission are exported for the test topology
// (`test/topology.ts`).

import { mkdir, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, extname, join } from "node:path";
import {
	type Address,
	type AdmitSelf,
	allow,
	constant,
	createHost,
	defineFacet,
	deny,
	type Facet,
	type Host,
	type HostError,
	keyedEntries,
	type Link,
	localeChoiceFacet,
	type PluginFailure,
	type RegistryTable,
	type RegistryValue,
	type Watchable,
} from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, type Context, withoutAbortSignal } from "@earendil-works/chord/context";
import {
	createHttp,
	Http,
	type HttpError,
	HttpListener,
	type HttpRequest,
	type HttpResponse,
	type ListenAddress,
} from "@earendil-works/chord/http";
import { createPlugins, type PluginsError, type PluginsState } from "@earendil-works/chord/plugins";
import { type PageAssets, pageScripts, webSurface } from "@earendil-works/chord/surfaces";
import * as v1 from "@earendil-works/p3/v1";
import { reportError, Server, Session, SessionAccess, until } from "@earendil-works/p3/v1";
import * as v1server from "@earendil-works/p3/v1/server";
import {
	LinkOpened,
	type LinkOpenedHook,
	ServerCommands,
	ServerRuntime,
	type WorkerRunner,
	WorkerRunners,
	type WorkerRunnerWrap,
	WorkerRunnerWraps,
} from "@earendil-works/p3/v1/server";
import { API, callerKey, KINDS, type P3Principal, SERVER, workerPrincipal } from "./app.ts";
import { openDataDir, openPrivateStore, privateDirectory } from "./files.ts";
import { WEB_ENTRY } from "./install.ts";
import { type ServerAnswer, type ServerStatus, serverSocket, takeSocket } from "./local-socket.ts";

/** What the server's start takes. */
export type ServerOptions = {
	readonly dataDir: string;
	/** Where sessions work by default (a folder each); `~/p3-work` unless given. */
	readonly workRoot?: string;
	/** The plugin roots: p3's built-in one first (`required`: a plugin of it failing fails the start). */
	readonly roots: readonly { readonly path: string; readonly required: boolean }[];
	/** Where it listens: `127.0.0.1` and this port (0: a free one). */
	readonly port: number;
	/** How a session's worker process starts. */
	readonly worker: { readonly entry: string; readonly execArgv: readonly string[] };
	/** How long a worker idles before it stops itself: 5 minutes by default. */
	readonly workerIdleMs?: number;
	/** p3's version, for the command's `status`. */
	readonly version: string;
	/** Facets of the server's own besides the base's, loaded with them (the memory test's telemetry ingest). */
	readonly facets?: readonly { readonly name: string; readonly facet: Facet<P3Principal> }[];
	/**
	 * What ends the server's process: the owner's stop (`stopped`: close, exit 0), or a failed store (`failed`: close,
	 * exit non-zero, so a supervisor starts it again). Also asked while the server starts.
	 */
	readonly onStop: (end: ServerEnd) => void;
	readonly onError: (error: ServerError) => void;
};

/** Why the server ends: the owner stopped it, or its store failed (the host closed itself, Chord design §3). */
export type ServerEnd = { readonly kind: "stopped" } | { readonly kind: "failed"; readonly error: unknown };

/** What the server reports in the background. */
export type ServerError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "http"; readonly error: HttpError }
	| { readonly kind: "plugins"; readonly error: PluginsError }
	/** A plugin of a root that is not required failed at the start (its build, evaluation or setup): left out. */
	| { readonly kind: "plugin_failed"; readonly error: PluginFailure };

/** A running server. */
export type RunningServer = {
	readonly dataDir: string;
	readonly port: number;
	readonly runtime: ServerRuntime;
	/** The runner the base uses: the one runner with the plugins' wraps composed over it. */
	readonly runner: UsedRunner;
	/** The plugins' marks (`dirty`, ...): what a test or a tool waits on before an apply. */
	readonly plugins: Watchable<PluginsState>;
	/** Closes everything it opened, the data directory's socket last; a second call waits for the first. */
	close(context: Context): Promise<void>;
};

/** How long a worker idles before it stops itself, by default. */
export const IDLE_MS = 5 * 60_000;

/** Starts the server: resolves once its plugins are loaded and it listens; a failure closes what it opened. */
export async function startServer(options: ServerOptions, context: Context): Promise<RunningServer> {
	const dataDir = await openDataDir(options.dataDir);
	const answering: Answering = { status: { kind: "starting" }, host: undefined, runner: undefined };
	const taken = await takeSocket(serverSocket(dataDir), context, (request) => answer(request, answering, context));
	if (taken.kind === "held") throw new Error(`p3: another server runs on ${dataDir}`);
	const closers: ((context: Context) => Promise<void> | void)[] = [() => taken.socket.release()];
	let closing: Promise<void> | undefined;
	const close = (ctx: Context): Promise<void> => {
		closing ??= closeAll(closers, ctx);
		return closing;
	};
	try {
		await privateDirectory(join(dataDir, "server"));
		// Made now, so the plugin watcher watches a root nobody created yet (the user's): a plugin added later is seen.
		for (const { path } of options.roots) await mkdir(path, { recursive: true });
		const store = await openPrivateStore(join(dataDir, "server", "store.sqlite"), context);
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
					return;
				}
				options.onError({ kind: "host", error });
				if (error.kind === "storage_failed") options.onStop({ kind: "failed", error: error.error });
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
					opened: (request, principal, closeLink) => {
						const end = linkOpened?.value(request, closeLink);
						// A signed-in link no hook tracks (none loaded yet, one that threw) could never be closed by a revoke.
						if (end === undefined && principal.kind !== "server") closeLink();
						return end;
					},
				},
				onError: (error) => options.onError({ kind: "http", error }),
			},
			context,
		);
		// Closed before the host: it drains the requests the host's close would seal.
		closers.push((ctx) => http.close(ctx));
		const plugins = createPlugins(
			{
				roots: options.roots,
				api: API,
				kinds: KINDS,
				onError: (error) => options.onError({ kind: "plugins", error }),
			},
			context,
		);
		closers.push(() => plugins.close());
		// The page's base bundle is built at the first page request or apply, whichever comes first.
		const web = webSurface(host, {
			plugins,
			entry: WEB_ENTRY,
			paths: ["/", "/*"],
			page: (request, assets) => pageHtml(request.nonce, assets),
		});
		const used = usedRunner(host, context);
		const sessions = host.route(
			Session,
			{
				// Admission decides; a worker never reaches another session's worker.
				authorize: () => true,
				admit: admitRoute,
				resolve: async (address, routing) => ({
					link: await startWorker(used, address, routing),
					principal: workerPrincipal(address.params.id),
					trusted: true,
				}),
			},
			context,
		);
		let listening: ListenAddress | undefined;
		const runtime: ServerRuntime = {
			dataDir,
			workRoot: options.workRoot ?? join(homedir(), "p3-work"),
			machine: { user: userInfo().username, hostname: hostname() },
			host,
			store,
			sessions,
			worker: options.worker,
			workerIdleMs: options.workerIdleMs ?? IDLE_MS,
			workerScripts: async (ctx) => plugins.current("worker") ?? (await plugins.scripts("worker", ctx)),
			listening: () => listening,
			apply: async (ctx) => {
				const built = await plugins.build(plugins.state.value.dirty, ctx);
				// The runner is read when its step runs: the server step may have reloaded the runner plugin or a wrap's.
				const workers = {
					name: "workers",
					kinds: ["worker"],
					reload: async (step: typeof built, stepContext: Context) => {
						const runner = await used.now(stepContext);
						return runner === undefined ? { hosts: [] } : runner.reload(step, stepContext);
					},
				};
				return plugins.rollout([plugins.step("server", host), workers, web.step("web")], built, ctx);
			},
			stop: () => options.onStop({ kind: "stopped" }),
		};
		const core = [
			{ name: "chord.http", facet: http.facet },
			{ name: "chord.web", facet: web.facet },
			// Every page holds the caller's language choice (`LocaleChoice`) on the server: Chord's `startPage` follows it
			// for the page's language. Without this facet each page load leaves a hold nobody serves (`unbound_long`).
			{ name: "chord.locale.choice", facet: localeChoiceFacet<P3Principal>() },
			{ name: "p3.page", facet: pageFacet(await elanorAssets()) },
			{ name: "p3.server", facet: serverCoreFacet(runtime) },
			...(options.facets ?? []),
		];
		const loaded = await plugins.load(host, { kind: "server", core, modules: SERVER_MODULES }, context);
		for (const failed of loaded.failed) options.onError({ kind: "plugin_failed", error: failed });
		linkOpened = await host.registry(LinkOpened, context);
		// Its registries read now: a status while the host closes (which refuses reads) still names the workers.
		await used.now(context);
		answering.runner = used;
		listening = await Promise.race([http.listening(context), unheard.promise]);
		starting = false;
		answering.status = { kind: "running", port: listening.port, version: options.version, startedAt: Date.now() };
		answering.host = host;
		return { dataDir, port: listening.port, runtime, runner: used, plugins: plugins.state, close };
	} catch (error) {
		await close(context);
		throw error;
	}
}

/** The error of a listen on `address` that failed with `cause`: `EADDRINUSE` names the port. */
function listenFailed(address: ListenAddress, cause: unknown): Error {
	const code = (cause as NodeJS.ErrnoException | undefined)?.code;
	const why = code === "EADDRINUSE" ? "the port is in use" : cause instanceof Error ? cause.message : String(cause);
	return new Error(`p3: cannot listen on ${address.host}:${address.port}: ${why}`, { cause });
}

/**
 * Starts the worker of `address` with the runner `used` gives now, else the next one. While the runner plugin reloads
 * there is none (the old runner closes, its workers exit, then the new one is contributed), and a start the old runner
 * took before it was withdrawn is refused by its close: neither fails the holders, the worker starts on the next
 * runner. A start that fails while its runner is still the one used is the worker's failure. `context`'s abort
 * rejects. Exported for the base's tests.
 */
export async function startWorker(used: UsedRunner, address: Address<typeof Session>, context: Context): Promise<Link> {
	for (;;) {
		const runner = await used.next(context);
		try {
			return await runner.start(address, context);
		} catch (error) {
			// Its object withdraws a runner at its seal, before its close refuses starts: a withdrawn one is no failure.
			if ((await used.now(context)) === runner) throw error;
		}
	}
}

/**
 * The runner the base uses: the one runner (`WorkerRunners`) with the wraps (`WorkerRunnerWraps`) composed over it in
 * plugin order, the first innermost.
 */
export type UsedRunner = {
	/** The composed runner now; `undefined` while no runner is contributed. */
	now(context: Context): Promise<WorkerRunner | undefined>;
	/**
	 * The composed runner now, else the last one composed: a runner withdrawn by a reload of its plugin still stops its
	 * workers, and the status names them (`p3 stop` kills them when the server does not stop).
	 */
	last(context: Context): Promise<WorkerRunner | undefined>;
	/** The composed runner now, or once a runner is contributed; `context`'s abort rejects. */
	next(context: Context): Promise<WorkerRunner>;
};

/** The two registries the used runner is composed from. */
type RunnerRegistries = readonly [RegistryValue<WorkerRunner | undefined>, RegistryValue<readonly WorkerRunnerWrap[]>];

/**
 * The runner `host`'s base uses, composed again only when the runner or the wraps changed: a wrap's runner is the same
 * object from one start to the next. The registries are read in `context` (the server's), at the first use. Exported
 * for the base's tests.
 */
export function usedRunner(host: Host<P3Principal>, context: Context): UsedRunner {
	const read = registriesOf(host, context);
	let composed:
		| { readonly runner: WorkerRunner; readonly wraps: readonly WorkerRunnerWrap[]; readonly value: WorkerRunner }
		| undefined;
	const now = async (caller: Context): Promise<WorkerRunner | undefined> => {
		const [runners, wraps] = await read(caller);
		const runner = runners.value;
		if (runner === undefined) return undefined;
		if (composed?.runner !== runner || composed.wraps !== wraps.value) {
			composed = { runner, wraps: wraps.value, value: wraps.value.reduce((inner, wrap) => wrap(inner), runner) };
		}
		return composed.value;
	};
	return {
		now,
		last: async (caller) => (await now(caller)) ?? composed?.value,
		next: async (caller) => {
			for (;;) {
				const runner = await now(caller);
				if (runner !== undefined) return runner;
				const [runners] = await read(caller);
				await until(runners, (next) => next !== undefined, caller);
			}
		},
	};
}

/**
 * The registries of the used runner on `host`, read in `context` at the first call and kept (each caller waits in its
 * own context): `host.registry` refuses once the host closes, and the status still names the workers then.
 */
function registriesOf(host: Host<P3Principal>, context: Context): (caller: Context) => Promise<RunnerRegistries> {
	let registries: Promise<RunnerRegistries> | undefined;
	return (caller) => {
		if (registries === undefined) {
			const own = withoutAbortSignal(context);
			const reading = Promise.all([
				host.registry(WorkerRunners, own),
				host.registry(WorkerRunnerWraps, own),
			] as const);
			registries = reading;
			// A read that failed (the host closed before its load published) is not kept.
			reading.catch(() => {
				if (registries === reading) registries = undefined;
			});
		}
		return awaitWithContext(registries, caller);
	};
}

/** Runs every closer, the last added first, each also when an earlier one failed; throws what failed. */
async function closeAll(closers: readonly ((context: Context) => Promise<void> | void)[], context: Context) {
	const failed: unknown[] = [];
	for (const closer of [...closers].reverse()) {
		try {
			await closer(context);
		} catch (error) {
			failed.push(error);
		}
	}
	if (failed.length > 0) throw new AggregateError(failed, "p3: the server's close failed");
}

/**
 * What the server is to its socket: starting, then running with its host (whose registries answer commands); the runner
 * it uses once its plugins loaded (a status names its workers, also those of one withdrawn by a reload of the runner
 * plugin, which kills its own workers after their grace).
 */
type Answering = {
	status:
		| { readonly kind: "starting" }
		| { readonly kind: "running"; readonly port: number; readonly version: string; readonly startedAt: number };
	host: Host<P3Principal> | undefined;
	runner: UsedRunner | undefined;
};

/** The server's answer to the command's `request` (`local-socket.ts`). */
async function answer(request: unknown, answering: Answering, context: Context): Promise<ServerAnswer> {
	// A trust boundary: a request on the socket (only the owner's processes reach it; its shape is still checked).
	const { kind, name } = (typeof request === "object" && request !== null ? request : {}) as {
		readonly kind?: unknown;
		readonly name?: unknown;
	};
	// Asked at each status: `p3 stop` kills the workers by the pids it gets right before.
	const status = async (): Promise<ServerStatus> => {
		const own = { pid: process.pid, workers: (await answering.runner?.last(context))?.pids() ?? [] };
		return answering.status.kind === "starting" ? { kind: "starting", ...own } : { ...answering.status, ...own };
	};
	if (kind === "status") return status();
	if (kind !== "command" || typeof name !== "string") return { kind: "invalid" };
	// A command waits for the plugins: while starting, the answer says so and the command asks again.
	if (answering.host === undefined) return status();
	const command = (await answering.host.registry(ServerCommands, context)).value.get(name);
	if (command === undefined) return { kind: "unknown", name };
	return { kind: "answer", value: await command.run(context) };
}

/** The API's modules the server evaluates its plugins' server facets with: this process's instances, by specifier. */
export const SERVER_MODULES = { "@earendil-works/p3/v1": v1, "@earendil-works/p3/v1/server": v1server };

/**
 * The base's facet: it serves `ServerRuntime` (the process values), `WorkerRunners` (the one runner: the first by
 * plugin name, a second one reported as a conflict), `WorkerRunnerWraps` (in plugin order), `LinkOpened` (every hook
 * called, in plugin order) and `ServerCommands` (each name's first command by plugin name; a second one of a name is
 * reported as a conflict).
 */
export function serverCoreFacet(runtime: ServerRuntime): Facet<P3Principal> {
	return defineFacet<P3Principal>((host) => {
		host.serve(ServerRuntime, { compose: () => runtime });
		host.serve(WorkerRunners, {
			compose: ([first, ...others], { report }) => {
				// Two runners would each start workers of one session's store: a misconfiguration, never a choice.
				for (const other of others) {
					report({
						message: "a second runner is contributed: contribute a wrap (WorkerRunnerWraps) instead",
						plugins: [first!.plugin, other.plugin],
					});
				}
				return first?.value;
			},
		});
		host.serve(WorkerRunnerWraps, { compose: (table) => table.map(({ value }) => value) });
		host.serve(LinkOpened, { compose: (table) => (request, close) => linkOpened(table, request, close) });
		host.serve(ServerCommands, {
			compose: (table, { report }) => {
				const keyed = keyedEntries(table, (command) => ({ [command.name]: command }), report);
				return new Map([...keyed].map(([name, { value }]) => [name, value] as const));
			},
		});
	});
}

/**
 * Calls every plugin's hook on an accepted link, each on its own: one that throws is reported and the others still
 * see the link; the disposers they returned are called the same way once it closed.
 */
function linkOpened(
	table: RegistryTable<LinkOpenedHook>,
	request: HttpRequest,
	close: () => void,
): (() => void) | undefined {
	const ends: { readonly plugin: string; readonly end: () => void }[] = [];
	for (const { plugin, value } of table) {
		const end = isolated(plugin, () => value(request, close));
		if (end !== undefined) ends.push({ plugin, end });
	}
	return ends.length === 0 ? undefined : disposerOf(ends);
}

/**
 * The disposer of a link's hooks: each one's `end`, on its own. Made apart from `linkOpened`, whose scope holds the
 * request: a closure there would keep the request for as long as the link stays open.
 */
function disposerOf(ends: readonly { readonly plugin: string; readonly end: () => void }[]): () => void {
	return () => {
		for (const { plugin, end } of ends) isolated(plugin, end);
	};
}

/** `run`'s result, or `undefined` when it threw: reported as `plugin`'s link hook failing. */
function isolated<T>(plugin: string, run: () => T): T | undefined {
	try {
		return run();
	} catch (error) {
		reportError(`p3: ${plugin}'s link hook`, error, BACKGROUND_CONTEXT);
		return undefined;
	}
}

/**
 * The route's admission: a caller reaches a session's worker only with access to the session, as the sessions
 * plugin answers it live (`SessionAccess`): no worker starts for a caller who would be denied, and one who loses
 * access is cut off. A worker never reaches another session's worker.
 */
export function admitRoute(principal: P3Principal, address: Address<typeof Session>, self: AdmitSelf) {
	if (principal.kind === "worker") return constant(deny("a worker reaches no other session's worker"));
	const answer = self.get(SessionAccess, { session: address.params.id, caller: callerKey(principal) });
	return self.derive([answer.access], ([access]) =>
		access === "none" ? deny("no access to this session") : allow(null),
	);
}

/**
 * The page: Elanor's fonts and the brand's tokens as stable files (`elanorAssets`), then the surface's bootstrap,
 * stylesheets and scripts, and the root the page's entry renders into.
 */
function pageHtml(nonce: string, assets: PageAssets): string {
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		"<title>Pi</title>",
		...ELANOR_STYLESHEETS.map((href) => `<link rel="stylesheet" href="${href}">`),
		pageScripts(assets, nonce),
		"</head>",
		'<body><div id="root"></div></body>',
		"</html>",
	].join("\n");
}

/** The stylesheets every page of p3 links before its own: Elanor's fonts and the `pi` brand's tokens. */
export const ELANOR_STYLESHEETS = ["/fonts/elanor/mallos-serif.css", "/fonts/elanor/commit-mono.css", "/tokens.css"];

/** The content types of Elanor's files the server serves. */
const MIME_TYPES: Readonly<Record<string, string>> = {
	".css": "text/css; charset=utf-8",
	".otf": "font/otf",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
};

/**
 * Elanor's fonts at `/fonts/elanor/` (their stylesheets, files and licenses, unchanged, so their relative URLs hold)
 * and the `pi` brand's tokens at `/tokens.css`, read from the installed packages once at the start: stable
 * URLs every page links, the owner link's too, public (fonts and colors are no secret).
 */
export async function elanorAssets(): Promise<ReadonlyMap<string, { readonly mime: string; readonly bytes: Buffer }>> {
	const require = createRequire(import.meta.url);
	const fontRoot = dirname(require.resolve("@earendil-works/elanor-fonts/mallos-serif.css"));
	const files = ["mallos-serif.css", "commit-mono.css"];
	for (const directory of ["files", "licenses"]) {
		for (const file of await readdir(join(fontRoot, directory))) files.push(`${directory}/${file}`);
	}
	const assets = new Map<string, { readonly mime: string; readonly bytes: Buffer }>();
	for (const file of files) {
		const mime = MIME_TYPES[extname(file)] ?? "application/octet-stream";
		assets.set(`/fonts/elanor/${file}`, { mime, bytes: await readFile(join(fontRoot, file)) });
	}
	const tokens = await readFile(require.resolve("@earendil-works/design-tokens/pi.css"));
	assets.set("/tokens.css", { mime: MIME_TYPES[".css"]!, bytes: tokens });
	return assets;
}

/** The base's page facet: Elanor's files (`elanorAssets`) as public routes. */
function pageFacet(assets: Awaited<ReturnType<typeof elanorAssets>>): Facet<P3Principal> {
	return defineFacet<P3Principal>((_host, self) => self.contribute(Http, { routes: assetRoutes(assets) }));
}

/** `assets` as public `GET` routes, cached for a day (they change only with an update of p3). */
function assetRoutes(assets: ReadonlyMap<string, { readonly mime: string; readonly bytes: Buffer }>) {
	const routes: Record<string, { readonly public: true; readonly handler: () => Promise<HttpResponse> }> = {};
	for (const [path, { mime, bytes }] of assets) {
		routes[`GET ${path}`] = {
			public: true,
			handler: async () => ({
				kind: "bytes",
				mime,
				size: bytes.length,
				inline: true,
				read: async (offset, length) => bytes.subarray(offset, offset + length),
				headers: { "Cache-Control": "public, max-age=86400" },
			}),
		};
	}
	return routes;
}
