// The p3 server's bootstrap: everything that must exist before plugins can load, and nothing else. It takes the data
// directory's lock, opens the server's store, creates the host, Chord's HTTP component (`/chord`) and plugins
// component, registers the route to session workers (its `resolve` asks the `WorkerRunners` registry, its `admit` the
// sessions plugin's `SessionRoute`), serves the base's registries (`ServerRuntime`, `WorkerRunners`, `LinkOpened`,
// `ServerCommands`), loads the server plugins and listens. The lock is the data directory's socket (`server.sock`,
// `local-socket.ts`), taken first: it also answers the command: what the server is, a stop, and the plugins'
// commands. Everything else is a plugin. The base's facet and the route's admission are exported for the test
// topology (`test/topology.ts`), which runs them as the server does.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type Address,
	type AdmitSelf,
	allow,
	type ChordStore,
	createHost,
	defineFacet,
	deny,
	type Facet,
	type Host,
	type HostError,
	openStore,
	orderedEntries,
	sqliteBackend,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { createHttp, type HttpError, HttpListener, type ListenAddress } from "@earendil-works/chord/http";
import { createPlugins, type PluginsError } from "@earendil-works/chord/plugins";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import * as v1 from "@earendil-works/p3/v1";
import { Server, Session } from "@earendil-works/p3/v1";
import * as v1server from "@earendil-works/p3/v1/server";
import {
	LinkOpened,
	type LinkOpenedHook,
	type ServerCommand,
	ServerCommands,
	ServerRuntime,
	SessionRoute,
	type WorkerRunner,
	WorkerRunners,
} from "@earendil-works/p3/v1/server";
import { API, KINDS, type P3Principal, SERVER, workerPrincipal } from "./app.ts";
import { openDataDir, privateDirectory, privateStore } from "./files.ts";
import { type ServerAnswer, type ServerStatus, serverSocket, takeSocket } from "./local-socket.ts";

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
	/** p3's version, for the command's `status`. */
	readonly version: string;
	/** Facets of the server's own besides the base's, loaded with them (the memory test's telemetry ingest). */
	readonly facets?: readonly { readonly name: string; readonly facet: Facet<P3Principal> }[];
	/** What the owner's stop does (the command's close); also asked while the server starts. */
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
	/** Closes everything it opened, the data directory's socket last; a second call waits for the first. */
	close(context: Context): Promise<void>;
};

/** How long a worker idles before it stops itself, by default. */
const IDLE_MS = 5 * 60_000;

/** Starts the server: resolves once its plugins are loaded and it listens; a failure closes what it opened. */
export async function startServer(options: ServerOptions, context: Context): Promise<RunningServer> {
	const dataDir = await openDataDir(options.dataDir);
	const answering: Answering = { status: { kind: "starting", pid: process.pid }, host: undefined };
	const taken = await takeSocket(serverSocket(dataDir), (request) => answer(request, answering, options, context));
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
				admit: admitSession,
				resolve: async (address, routing) => {
					const runner = await runnerOf(host, routing);
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
				// The runner is read when its step runs: the server step may have reloaded the runner plugin.
				const workers = {
					name: "workers",
					kinds: ["worker"],
					reload: async (step: typeof built, stepContext: Context) => {
						const runner = (await host.registry(WorkerRunners, stepContext)).value;
						return runner === undefined ? { hosts: [] } : runner.reload(step, stepContext);
					},
				};
				return plugins.rollout([plugins.step("server", host), workers], built, ctx);
			},
			stop: options.onStop,
		};
		const core = [
			{ name: "chord.http", facet: http.facet },
			{ name: "p3.server", facet: serverCoreFacet(runtime) },
			...(options.facets ?? []),
		];
		await plugins.load(host, { kind: "server", core, modules: SERVER_MODULES }, context);
		linkOpened = await host.registry(LinkOpened, context);
		listening = await Promise.race([http.listening(context), unheard.promise]);
		starting = false;
		answering.status = {
			kind: "running",
			pid: process.pid,
			port: listening.port,
			version: options.version,
			startedAt: Date.now(),
		};
		answering.host = host;
		return { dataDir, port: listening.port, runtime, close };
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
 * The runner the route starts workers with: the one contributed now, else the next one. While the runner plugin
 * reloads there is none (the old runner closes, its workers exit, then the new one is contributed): a held session's
 * worker starts again once the new runner is there, instead of failing its holders. `context`'s abort rejects.
 */
async function runnerOf(host: Host<P3Principal>, context: Context): Promise<WorkerRunner> {
	const runners = await host.registry(WorkerRunners, context);
	if (runners.value !== undefined) return runners.value;
	const watch = await runners.watch(context);
	try {
		return await new Promise<WorkerRunner>((resolve, reject) => {
			if (watch.value !== undefined) resolve(watch.value);
			context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true });
			watch.start(async (call) => {
				if (call.kind === "value" && call.value !== undefined) resolve(call.value);
			});
		});
	} finally {
		await watch.stop();
	}
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

/** What the server is to its socket: starting, then running with its host (whose registries answer commands). */
type Answering = { status: ServerStatus; host: Host<P3Principal> | undefined };

/** The server's answer to the command's `request` (`local-socket.ts`). */
async function answer(
	request: unknown,
	answering: Answering,
	options: Pick<ServerOptions, "onStop">,
	context: Context,
): Promise<ServerAnswer> {
	// A trust boundary: a request on the socket (only the owner's processes reach it; its shape is still checked).
	const { kind, name } = (typeof request === "object" && request !== null ? request : {}) as {
		readonly kind?: unknown;
		readonly name?: unknown;
	};
	if (kind === "status") return answering.status;
	if (kind === "stop") {
		options.onStop();
		return { kind: "stopping" };
	}
	if (kind !== "command" || typeof name !== "string") return { kind: "invalid" };
	// A command waits for the plugins: while starting, the answer says so and the command asks again.
	if (answering.host === undefined) return answering.status;
	const command = (await answering.host.registry(ServerCommands, context)).value.get(name);
	if (command === undefined) return { kind: "unknown", name };
	return { kind: "answer", value: await command.run(context) };
}

/** The API's modules the server evaluates its plugins' server facets with: this process's instances, by specifier. */
export const SERVER_MODULES = { "@earendil-works/p3/v1": v1, "@earendil-works/p3/v1/server": v1server };

/**
 * The base's facet: it serves `ServerRuntime` (the process values), `WorkerRunners` (the first runner by plugin name),
 * `LinkOpened` (every hook called, in plugin order) and `ServerCommands` (each name's first command by plugin order).
 */
export function serverCoreFacet(runtime: ServerRuntime): Facet<P3Principal> {
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
		host.serve(ServerCommands, {
			compose: (table) => {
				const commands = new Map<string, ServerCommand>();
				for (const { value } of table) if (!commands.has(value.name)) commands.set(value.name, value);
				return commands;
			},
		});
	});
}

/**
 * The route's admission: a session's worker is reached only while the session exists (the sessions plugin's
 * `SessionRoute`), and never by another session's worker.
 */
export function admitSession(principal: P3Principal, address: Address<typeof Session>, self: AdmitSelf) {
	const route = self.get(SessionRoute, { session: address.params.id });
	return self.derive([route.exists], ([exists]) =>
		principal.kind !== "worker" && exists ? allow(null) : deny("no such session"),
	);
}
