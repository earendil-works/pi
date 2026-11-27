// p3's API v1 for plugin tests (`@earendil-works/p3/v1/testing`), so a built-in and a third-party plugin test the same
// way, in the plugin's own `test/` folder, and no plugin test imports p3's base. `testPlugin`: one facet built as
// production builds it, on a host of its own beside the base's facet. `testServer`: p3's real server in the test's
// process with the built-in plugins and the plugins under test, its session workers as real processes, clients signed
// in as the owner.

import { mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	type ChordStore,
	createHost,
	type Host,
	memoryLinkPair,
	type PluginFacet,
	type Watchable,
	webSocketLink,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import {
	testPlugin as chordTestPlugin,
	type PluginsState,
	type RolloutResult,
	type TestedPlugin,
} from "@earendil-works/chord/plugins";
import { Server, Session } from "@earendil-works/p3/v1";
import type { ServerRuntime, WorkerState } from "@earendil-works/p3/v1/server";
import { SignIns } from "../../../plugins/sign-in/contract.ts";
import { API, KINDS, type P3Principal, SERVER, workerPrincipal } from "../../app.ts";
import { PLUGINS, WORKER } from "../../install.ts";
import { ASK_MS, askServer } from "../../local-socket.ts";
// The processes' own maps: a worker facet gets a worker's modules (never the server's), as in a real worker.
import { admitRoute, IDLE_MS, SERVER_MODULES, type ServerError, serverCoreFacet, startServer } from "../../server.ts";
import { WORKER_MODULES, workerCoreFacet } from "../../worker.ts";

export type { TestedPlugin } from "@earendil-works/chord/plugins";
export type { ServerError } from "../../server.ts";

/**
 * Which facet of a plugin a test loads: its server facet, or its worker facet on session `session`'s worker. Each gets
 * the base's facet as its real host has it, with a directory of its own (a new temporary one, removed at the close):
 * the server's `ServerRuntime` (it does not listen, starts no session worker and applies nothing), or the worker's
 * `WorkerRuntime` and `WorkerBusy`, with its idle time `idleMs` (5 minutes by default) and `close`, what its
 * `WorkerRuntime.close` does (nothing by default; a real worker exits).
 */
export type TestedFacet =
	| { readonly kind: "server"; readonly stubs?: readonly PluginFacet<P3Principal>[] }
	| {
			readonly kind: "worker";
			readonly session: string;
			readonly idleMs?: number;
			readonly close?: () => void;
			readonly stubs?: readonly PluginFacet<P3Principal>[];
			/**
			 * The facets of a stand-in server the worker's host is linked to, as a real worker is to its server (the
			 * worker's principal on that link): what serves the server contracts the facet holds (`SessionFacts`,
			 * `SessionAccess` behind `admitSession`). Without it the worker has no server.
			 */
			readonly server?: readonly PluginFacet<P3Principal>[];
	  };

/**
 * Builds the plugin in `root` as production builds it and loads its facet of `facet.kind` alone, on a host with the
 * principal and address of that kind's production host (the server, or the session's worker), with the API modules
 * that process has and the base's facet; `stubs` serve what it uses of other plugins.
 */
export async function testPlugin(
	root: string,
	facet: TestedFacet,
	context: Context,
): Promise<TestedPlugin<P3Principal>> {
	const dir = await mkdtemp(join(tmpdir(), "p3-test-plugin-"));
	let server: Host<P3Principal> | undefined;
	const host =
		facet.kind === "server"
			? { principal: SERVER, address: Server(), modules: SERVER_MODULES }
			: {
					principal: workerPrincipal(facet.session),
					address: Session({ id: facet.session }),
					modules: WORKER_MODULES,
				};
	try {
		const tested = await chordTestPlugin<P3Principal>(
			root,
			{
				kind: facet.kind,
				api: API,
				kinds: Object.keys(KINDS),
				platform: KINDS[facet.kind].platform,
				stubs: facet.stubs ?? [],
				hostStubs: (tested, store) => {
					if (facet.kind === "server") return serverStubs(tested, store, dir, context);
					if (facet.server !== undefined) server = standInServer(tested, facet.session, facet.server, context);
					return workerStubs(facet, tested, store, dir);
				},
				...host,
			},
			context,
		);
		// Its close also closes the stand-in server and removes the test's directory.
		const close = tested.close.bind(tested);
		tested.close = (ctx) =>
			close(ctx)
				.finally(() => server?.close(ctx))
				.finally(() => rm(dir, { recursive: true, force: true }));
		return tested;
	} catch (error) {
		await server?.close(context);
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

/**
 * A stand-in server at `Server()` with `facets`, loaded (not awaited: the worker's load may wait on it, as a real
 * worker's does) and linked to `worker`, session `session`'s worker host, as the server's route links a worker.
 */
function standInServer(
	worker: Host<P3Principal>,
	session: string,
	facets: readonly PluginFacet<P3Principal>[],
	context: Context,
): Host<P3Principal> {
	const server = createHost<P3Principal>({
		address: Server(),
		principal: SERVER,
		onError: (error) => console.error("testPlugin: the stand-in server:", error),
	});
	const [up, down] = memoryLinkPair();
	worker.connect(up, { principal: SERVER, trusted: true }, context);
	server.connect(down, { principal: workerPrincipal(session), trusted: true }, context);
	void server.load(facets, context).then(
		({ failed }) => failed.length > 0 && console.error("testPlugin: the stand-in server failed to load", failed),
		(error: unknown) => console.error("testPlugin: the stand-in server failed to load", error),
	);
	return server;
}

/** The base's facet of the server on the test's host, with a runtime whose server does not listen. */
function serverStubs(host: Host<P3Principal>, store: ChordStore, dataDir: string, context: Context) {
	const sessions = host.route(
		Session,
		{
			authorize: () => true,
			admit: admitRoute,
			resolve: () => Promise.reject(new Error("testPlugin: the plugin tier starts no session worker")),
		},
		context,
	);
	const runtime: ServerRuntime = {
		dataDir,
		machine: { user: userInfo().username, hostname: hostname() },
		host,
		store,
		sessions,
		worker: { entry: "", execArgv: [] },
		workerIdleMs: IDLE_MS,
		// No catalog request leaves a plugin's test.
		catalogBaseUrl: undefined,
		workerScripts: async () => [],
		listening: () => undefined,
		apply: () => Promise.reject(new Error("testPlugin: the plugin tier applies nothing")),
		stop: () => {},
	};
	return [{ name: "p3.server", facet: serverCoreFacet(runtime) }];
}

/** The base's facet of a worker on the test's host, as a real worker loads it. */
function workerStubs(
	facet: Extract<TestedFacet, { readonly kind: "worker" }>,
	host: Host<P3Principal>,
	store: ChordStore,
	dir: string,
) {
	const runtime = {
		session: facet.session,
		host,
		store,
		dir,
		idleMs: facet.idleMs ?? IDLE_MS,
		close: facet.close ?? (() => {}),
	};
	return [{ name: "p3.worker", facet: workerCoreFacet(runtime) }];
}

/** What a test's server starts with. */
export type TestServerOptions = {
	/**
	 * The plugins under test: their directories (a relative one from the working directory), loaded beside the built-in
	 * plugins from a root of their own; one that is missing or fails to load fails the start.
	 */
	readonly plugins?: readonly string[];
	/** A copy of the built-in plugins that the test edits and applies; p3's own by default. */
	readonly builtIn?: string;
	/** A data directory a stopped test server left, to start on again; a new temporary one by default. */
	readonly dataDir?: string;
	/** How long a worker idles before it stops itself: 300 ms by default, so a test sees it stop. */
	readonly idleMs?: number;
};

/** A test's server: p3's real one, on its own data directory. */
export type TestServer = {
	readonly dataDir: string;
	/** Where it listens on `127.0.0.1`. */
	readonly port: number;
	/** The server's host: `host.root` runs code as the server; its registries are the base's (`ServerRuntime`, ...). */
	readonly host: Host<P3Principal>;
	/** The data directory's user root (`<data directory>/plugins`), where a test writes plugins of its own to apply. */
	readonly userRoot: string;
	/** The plugins' marks: what an apply would build (`dirty`); a test waits on them before it applies an edit. */
	readonly plugins: Watchable<PluginsState>;
	/** What the server reported in the background. */
	readonly errors: readonly ServerError[];
	/** How long its workers idle before they stop themselves. */
	readonly idleMs: number;
	/**
	 * A new client over WebSocket, as a browser's page is (closed with the server): signed in as the owner, or as
	 * `principal` (a person, with a sign-in issued for them as an invite link's page gets one).
	 */
	client(context: Context, principal?: P3Principal): Promise<Host<P3Principal>>;
	/** A fresh owner's sign-in cookie (`name=value`), as a browser gets it from an owner link. */
	cookie(context: Context): Promise<string>;
	/** Each session's worker as the runner the base uses sees it (the one runner with the wraps over it). */
	workers(context: Context): Promise<Readonly<Record<string, WorkerState>>>;
	/** Builds the changed plugins and rolls them out, as `p3 apply` does. */
	apply(context: Context): Promise<RolloutResult>;
	/**
	 * Stops the server, then starts a new one on the same data directory with the same options: the new one owns the
	 * data directory from then on (this one's `close` leaves it).
	 */
	restart(context: Context): Promise<TestServer>;
	/**
	 * Closes the clients, then the server, also when a client's close failed (it rejects with that afterwards), keeping
	 * the data directory; once: a second call waits for the first.
	 */
	stop(context: Context): Promise<void>;
	/** Stops the server and removes its data directory, unless the server's close failed or a restart took it over. */
	close(context: Context): Promise<void>;
};

/**
 * Starts p3's real server in this process on a new temporary data directory (or on `options.dataDir`): the built-in
 * plugins, the plugins under test and the data directory's user root, built as a Pi builds them; its session workers
 * forked as real processes.
 */
export async function testServer(options: TestServerOptions, context: Context): Promise<TestServer> {
	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "p3-test-")));
	const tested = await mkdtemp(join(tmpdir(), "p3-tested-"));
	const userRoot = join(dataDir, "plugins");
	const idleMs = options.idleMs ?? TEST_IDLE_MS;
	const errors: ServerError[] = [];
	try {
		for (const plugin of options.plugins ?? []) {
			const dir = await pluginDirectory(plugin);
			await symlink(dir, join(tested, basename(dir)), "dir");
		}
		const server = await startServer(
			{
				dataDir,
				roots: [
					{ path: options.builtIn ?? PLUGINS, required: true },
					{ path: tested, required: true },
					{ path: userRoot, required: false },
				],
				port: 0,
				version: "test",
				worker: WORKER,
				workerIdleMs: idleMs,
				onStop: () => {},
				onError: (error) => errors.push(error),
			},
			context,
		);
		const host = server.runtime.host;
		const clients: Host<P3Principal>[] = [];
		/** Set once the server closed: only then may its data directory go. */
		let closed = false;
		/** Set once a restart's server runs: the data directory is its own from then on. */
		let handedOver = false;
		const stopOnce = async (ctx: Context): Promise<void> => {
			const failed: unknown[] = [];
			for (const client of clients.splice(0)) {
				await client.close(ctx).catch((error: unknown) => void failed.push(error));
			}
			try {
				await server.close(ctx);
				closed = true;
			} finally {
				await rm(tested, { recursive: true, force: true });
			}
			if (failed.length > 0) throw new AggregateError(failed, "testServer: a client's close failed");
		};
		let stopping: Promise<void> | undefined;
		const stop = (ctx: Context): Promise<void> => {
			stopping ??= stopOnce(ctx);
			return stopping;
		};
		return {
			dataDir,
			port: server.port,
			host,
			userRoot,
			plugins: server.plugins,
			errors,
			idleMs,
			client: async (ctx, principal) => {
				const client =
					principal === undefined
						? await ownerClient(dataDir, server.port, ctx)
						: await signedInClient(host, server.port, principal, ctx);
				clients.push(client);
				return client;
			},
			cookie: (ctx) => ownerCookie(dataDir, server.port, ctx),
			workers: async (ctx) => (await server.runner.now(ctx))?.state() ?? {},
			apply: (ctx) => server.runtime.apply(ctx),
			restart: async (ctx) => {
				await stop(ctx);
				const next = await testServer({ ...options, dataDir }, ctx);
				handedOver = true;
				return next;
			},
			stop,
			close: async (ctx) => {
				try {
					await stop(ctx);
				} finally {
					if (closed && !handedOver) await rm(dataDir, { recursive: true, force: true });
				}
			},
		};
	} catch (error) {
		await rm(tested, { recursive: true, force: true });
		if (options.dataDir === undefined) await rm(dataDir, { recursive: true, force: true });
		throw error;
	}
}

/**
 * The real path of the plugin directory `plugin` (a relative one from the working directory): a link to a path that is
 * no directory would leave the plugins' root empty, and the start pass without the plugin.
 */
async function pluginDirectory(plugin: string): Promise<string> {
	const dir = await realpath(resolve(plugin)).catch(() => undefined);
	if (dir === undefined || !(await stat(dir)).isDirectory()) {
		throw new Error(`testServer: no plugin directory at ${plugin}`);
	}
	return dir;
}

/** How long a test server's worker idles before it stops itself, by default. */
const TEST_IDLE_MS = 300;

/**
 * A client host connected over WebSocket to the server of `dataDir` (any running p3 server, a launched `p3 server`
 * too) on `port`, signed in as the owner with a fresh owner link's cookie, loaded with no plugins; a call waits
 * `readyTimeout` ms at most for its object.
 */
export async function ownerClient(
	dataDir: string,
	port: number,
	context: Context,
	readyTimeout = 10_000,
): Promise<Host<P3Principal>> {
	return clientWith({ cookie: await ownerCookie(dataDir, port, context) }, port, context, readyTimeout);
}

/** A client host connected over WebSocket to the server `host` on `port`, signed in as `principal` with a new sign-in. */
async function signedInClient(
	host: Host<P3Principal>,
	port: number,
	principal: P3Principal,
	context: Context,
): Promise<Host<P3Principal>> {
	const issued = await host.root(
		async (ctx) => (await ctx.get(SignIns, {})).issue({ principal, label: "test", kind: "device" }, ctx),
		context,
	);
	return clientWith({ authorization: `Bearer ${issued.token}` }, port, context, 10_000);
}

/** A client host connected over WebSocket on `port` with `headers`, loaded with no plugins. */
async function clientWith(
	headers: Readonly<Record<string, string>>,
	port: number,
	context: Context,
	readyTimeout: number,
): Promise<Host<P3Principal>> {
	// Node's WebSocket (undici) takes an init object with headers; the DOM type knows only protocols.
	const init = { headers } as unknown as string[];
	const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`, init);
	const client = createHost<P3Principal>({ readyTimeout, onError: (error) => console.error("client:", error) });
	client.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);
	await client.load([], context);
	return client;
}

/**
 * A fresh owner's sign-in cookie (`name=value`) from the server of `dataDir` on `port`, as `p3` and a browser get it:
 * the command `owner-link` over the data directory's socket, then the link's token posted as the link's page posts it.
 */
export async function ownerCookie(dataDir: string, port: number, context: Context): Promise<string> {
	const reply = await askServer(dataDir, { kind: "command", name: "owner-link" }, ASK_MS);
	if (reply.kind !== "answered" || reply.answer.kind !== "answer") {
		throw new Error(`ownerCookie: no owner link: ${JSON.stringify(reply)}`);
	}
	const token = new URL(String(reply.answer.value)).hash.slice(1);
	const signedIn = await fetch(`http://127.0.0.1:${port}/_p3/owner`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token }),
		signal: context.abortSignal,
	});
	const cookie = signedIn.headers.get("set-cookie")?.split(";")[0];
	if (!signedIn.ok || cookie === undefined) throw new Error(`ownerCookie: the sign-in failed: ${signedIn.status}`);
	return cookie;
}
