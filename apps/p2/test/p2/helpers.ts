import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Address,
	type ChordError,
	type ChordErrorCode,
	type Contract,
	isChordError,
	memoryLinkPair,
	type ParamsOf,
	type PluginFacet,
	type Registry,
	type WebSocketLike,
	webSocketLink,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { NativeWatchable, Watchable } from "@earendil-works/chord/watch";
import { WebSocket as NodeWebSocket } from "ws";
import type { WebManifest } from "../../src/hosts/bundles.ts";
import { type P2Server, type ServerOptions, startServer } from "../../src/hosts/server.ts";
import { WEB_MANIFEST_PATH } from "../../src/hosts/web.ts";
import {
	type Ctx,
	createHost,
	defineFacet,
	type Facet,
	type FacetHost,
	type Held,
	type Host,
	type HostError,
	hostErrorText,
	type Self,
	Server,
	serveNative,
	type VariantOf,
} from "../../src/runtime/chord.ts";
import { localOwnerSignIn } from "../../src/runtime/local-owner.ts";
import { HOST, type P2Principal, SERVER } from "../../src/runtime/principals.ts";
import { follow, type HeldIn, type HeldRef, whenLive } from "../../src/runtime/refs.ts";
import {
	ServerNatives,
	type ServerParts,
	type SessionWorkerControl,
	serveServerRegistries,
} from "../../src/runtime/server.ts";
import { webCoreFacet } from "../../src/runtime/web-core.ts";
import {
	HarnessHost,
	HarnessNative,
	type HarnessParts,
	Liveness,
	SessionLocation,
	serveWorkerRegistries,
	type WorkerParts,
	WorkerProcess,
} from "../../src/runtime/worker.ts";

// Chord's test-only parts, for the test files: they import Chord only through this module (and the plugin API), so the
// switch to Chord v2 changes these helpers rather than every test.
export { binaryCodec, ChordError, memoryLinkPair } from "@earendil-works/chord";
export { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/** Chord's reports of mistakes that would wait (a request nobody serves, a registry without provider): always a bug. */
const MISTAKES = new Set(["registry_undeclared", "unbound_long", "transaction_cancelled"]);

/** A test host's `onError`: mistakes are printed (the full run greps for them); `record` gets every error. */
const reportTo =
	(record: (error: HostError) => void = () => {}) =>
	(error: HostError): void => {
		if (MISTAKES.has(error.kind)) console.error(`p2 test host: ${hostErrorText(error)}`);
		record(error);
	};

/** The context of test calls made outside any Chord call (a test's own steps). */
export const TEST = BACKGROUND_CONTEXT;

/** What `clientHost` connects over: a WebSocket to a p2 server's `/chord` (`ws`'s or the global one). */
export type ClientSocket = NodeWebSocket | WebSocket;

/** A local owner session at a p2 server: its port, and the cookie pair the owner's browser or TUI sends there. */
export type LocalOwner = { readonly port: number; readonly cookie: string };

/** Signs in to `server` as its local owner, as the TUI on its host does (with the owner key of its data directory). */
export async function localOwner(server: Pick<P2Server, "port" | "dataDir">): Promise<LocalOwner> {
	const signIn = await localOwnerSignIn(new URL(`http://127.0.0.1:${server.port}`), server.dataDir);
	if (signIn.kind === "unavailable") throw new Error(signIn.message);
	return { port: server.port, cookie: signIn.cookie };
}

/**
 * A browser-like client host connected to a p2 server's `/chord`, as the web UI connects: as the local `owner`, or over
 * `socket` (one that sends headers: a tunnel Host, a guest cookie, a relay).
 */
export function clientHost(target: LocalOwner | ClientSocket, facets: readonly PluginFacet<P2Principal>[] = []): Host {
	const socket =
		"cookie" in target
			? new NodeWebSocket(`ws://127.0.0.1:${target.port}/chord`, { headers: { Cookie: target.cookie } })
			: target;
	const host = createHost({ onError: reportTo() });
	// Both sockets have the subset of the WebSocket API the link uses; the types differ in their event signatures.
	host.connect(webSocketLink(socket as unknown as WebSocketLike), { principal: SERVER }, TEST);
	// Holds wait until the host has loaded (`facets`: web facets, say; the web's core is added for them).
	void host.load(facets.length ? [{ name: "@p2/web-core", facet: webCoreFacet }, ...facets] : [], TEST);
	return host;
}

export type Fixture = {
	readonly server: P2Server;
	readonly dataDir: string;
	readonly workspace: string;
	/** The local owner's session (needs the devices plugin, which signs it in). */
	readonly owner: LocalOwner;
	/**
	 * A browser-like client host of the local owner over a real WebSocket (as the web UI connects), with `facets` loaded
	 * (web facets).
	 */
	browser(facets?: readonly PluginFacet<P2Principal>[]): Host;
	/** A client host whose WebSocket sends `headers` (a tunnel Host, a guest cookie), and that socket. */
	client(headers: Record<string, string>): { host: Host; socket: NodeWebSocket };
	/** A memory-linked client the server accepts as `principal` (a relay owner, a worker, a guest of a test). */
	as(principal: P2Principal): Host;
	/** An HTTP request to the server as the local owner: its cookie, unless `options.headers` names another. */
	http(path: string, options?: HttpOptions): Promise<HttpResult>;
	close(): Promise<void>;
};

/** The p2 app directory, as the server tells facets (`Server.info.app`, `WorkerInit.app`). */
export const APP = fileURLToPath(new URL("../../", import.meta.url));

export async function startFixture(options: ServerOptions = {}): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "p2-test-"));
	const dataDir = join(root, "data");
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	let server: P2Server;
	try {
		server = await startServer({
			dataDir,
			port: 0,
			fake: true,
			web: false,
			...options,
		});
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	const browsers: Host[] = [];
	const owner = server.plugins.includes("devices") ? await localOwner(server) : undefined;
	const ownerOf = (): LocalOwner => {
		if (owner === undefined) throw new Error("A fixture without the devices plugin has no local owner");
		return owner;
	};
	return {
		server,
		dataDir,
		workspace,
		get owner() {
			return ownerOf();
		},
		browser: (facets = []) => {
			const browser = clientHost(ownerOf(), facets);
			browsers.push(browser);
			return browser;
		},
		client: (headers) => {
			const socket = new NodeWebSocket(`ws://127.0.0.1:${server.port}/chord`, { headers });
			const client = clientHost(socket);
			browsers.push(client);
			return { host: client, socket };
		},
		as: (principal) => {
			const [down, up] = memoryLinkPair();
			server.host.accept(down, { principal }, TEST);
			const client = createHost({ onError: reportTo() });
			client.connect(up, { principal: SERVER }, TEST);
			void client.load([], TEST);
			browsers.push(client);
			return client;
		},
		http: (path, options = {}) =>
			http(server.port, path, { ...options, headers: { Cookie: ownerOf().cookie, ...options.headers } }),
		close: async () => {
			for (const browser of browsers) await browser.close(TEST).catch(() => {});
			await server.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * `type(params)` held on `host`, live, and narrowed to `variant`: rejects `invalid/member` when the host's principal
 * gets another variant, and with the error when the reference ends or fails broken.
 */
export async function holdIn<C extends Contract, const V extends VariantOf<C>>(
	host: Pick<Host, "hold">,
	type: C,
	params: ParamsOf<C>,
	variant: V,
): Promise<HeldIn<C, V & string>> {
	const ref = host.hold(type, params, TEST);
	await whenLive(ref);
	return narrowed(ref, variant);
}

/**
 * `holdIn` for an older contract version: fails, naming the state, when the reference does not bind (a version the
 * provider does not accept is left `failed { waiting }` with `contract_mismatch`, where `holdIn` would wait).
 */
export async function boundIn<C extends Contract, const V extends VariantOf<C>>(
	host: Pick<Host, "hold">,
	type: C,
	params: ParamsOf<C>,
	variant: V,
): Promise<HeldIn<C, V & string>> {
	return narrowed(await bound(host.hold(type, params, TEST)), variant);
}

/** `ref` once live; fails, naming the state, when it fails instead (`contract_mismatch`, say). */
export async function bound<R extends HeldRef>(ref: R): Promise<R> {
	const state = await until(ref.state, (value) => value.kind === "live" || value.kind === "failed", 10_000);
	assert.equal(state.kind, "live", `not bound: ${JSON.stringify(state)}`);
	return ref;
}

/** A live `ref` narrowed to `variant`; rejects `invalid/member` (releasing it) for another variant. */
function narrowed<C extends Contract, V extends VariantOf<C>>(ref: Held<C>, variant: V): HeldIn<C, V & string> {
	if (ref.variant !== variant) {
		ref.release();
		throw Object.assign(new Error(`expected variant ${String(variant)}, got ${String(ref.variant)}`), {
			code: "invalid",
			reason: "member",
		});
	}
	return ref as unknown as HeldIn<C, V & string>;
}

/**
 * A stub's in-memory state member (v1's `self.state`): the member itself plus `replace`/`change` for the test to drive
 * it. The context arguments are kept for the tests' call shape and unused.
 */
export type Cell<T> = {
	readonly value: T;
	replace(ctx: unknown, value: T): void;
	change(ctx: unknown, fn: (draft: T) => void): void;
};

/** What a stub factory gets: its object's `self`, plus `state` for in-memory state members. */
export type StubSelf = Self & {
	state<T>(initial: T): Cell<T>;
};

/**
 * A stub factory: `(params, principal, self)` returning its members, flat (`variant` among them for remote types), as
 * v1 factories did. Methods may return nothing; cells come from `self.state`.
 */
export type StubFactory = (params: never, principal: P2Principal, self: StubSelf) => Record<string, unknown>;
/** A stub is a contract plus its members, or a factory of them. */
export type Stub = readonly [Contract, Record<string, unknown> | StubFactory];

const CELL = Symbol("p2.test-cell");

/** `self` with `state`: each cell is a writable exposed through a derive (state members must be JSON watchables). */
function stubSelf(self: Self): StubSelf {
	const state = <T>(initial: T): Cell<T> => {
		const writable = self.writable(initial);
		const member = self.derive([writable], ([value]) => value as never);
		return {
			[CELL]: member,
			get value() {
				return writable.value;
			},
			replace: (_ctx, value) => writable.set(value),
			change: (_ctx, fn) => {
				const draft = structuredClone(writable.value);
				fn(draft);
				writable.set(draft);
			},
		} as Cell<T>;
	};
	// Self's methods use its private fields: they are called on the object itself.
	return new Proxy(self, {
		get: (target, key) => {
			if (key === "state") return state;
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as StubSelf;
}

/** A stub's members as Chord takes them: cells as their members, methods answering `null` for nothing. */
function members(flat: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(flat).map(([name, value]) => {
			if (value && typeof value === "object" && CELL in value) return [name, (value as { [CELL]: unknown })[CELL]];
			if (typeof value === "function")
				return [
					name,
					async (...args: unknown[]) => (await (value as (...args: unknown[]) => unknown)(...args)) ?? null,
				];
			return [name, value];
		}),
	);
}

/** Serves `stub` on `host`: a local type's factory gets `(params, self)`, a remote one's `(params, principal, self)`. */
function serveStub(host: FacetHost, [type, value]: Stub): void {
	const factory: StubFactory = typeof value === "function" ? value : () => value;
	const remote = (type as { readonly kind?: string }).kind === "remote";
	// The stub's contract is any contract: its factory is checked by the test's behaviour, not by its types.
	const serve = host.serve as unknown as (type: Contract, factory: (...args: never[]) => unknown) => void;
	if (remote)
		serve(type, (params: never, principal: P2Principal, self: Self) => {
			const { variant, ...rest } = factory(params, principal, stubSelf(self));
			return { variant, members: members(rest) };
		});
	else serve(type, (params: never, self: Self) => members(factory(params, HOST, stubSelf(self))));
}

/** A facet that serves single-native registry `registry` and contributes `value` (a stub for a plugin's native). */
export function nativeFacet<V>(registry: Registry<V, V | undefined>, value: V): Facet {
	return defineFacet((host, self) => {
		serveNative(host, registry);
		self.contribute(registry, value);
	});
}

/** A test server's workers: none run, and none can be controlled. */
const NO_WORKERS: SessionWorkerControl = {
	generation: () => 0,
	running: () => [],
	relocate: async () => {
		throw new Error("no workers in a test host");
	},
	pause: async () => {
		throw new Error("no workers in a test host");
	},
	retry: async () => ({ running: false, generation: 0, error: "no workers in a test host" }),
	resume: async () => {},
	stop: async () => {},
	suspend: async () => {},
	subscribe: () => () => {},
	observe: () => ({ value: {}, detach: () => {} }),
};

/**
 * A worker host's natives for a bare test host (`kind: "worker"`): the session's Harness (`harnessOf`) and the worker
 * process (`workerOf`). Unset parts are inert: no location moves, liveness counts nothing, roots run on `TEST`.
 */
export function workerFacet(parts: {
	readonly harness: HarnessParts;
	readonly worker?: Partial<WorkerParts>;
	/** The host the worker's roots run on (`WorkerParts.root`); none: roots are refused. */
	readonly host?: () => Host;
}): Facet {
	return defineFacet((host, self) => {
		serveNative(host, HarnessNative);
		serveNative(host, WorkerProcess);
		host.serve(HarnessHost, () => ({}));
		self.contribute(HarnessNative, parts.harness);
		self.contribute(WorkerProcess, {
			init: {} as WorkerParts["init"],
			liveness: new Liveness(),
			location: new SessionLocation({ cwd: "/", env: null }),
			root: (fn, context) => {
				if (!parts.host) throw new Error("no root in this test worker");
				return parts.host().root(fn, context);
			},
			copyFilesTo: async () => {
				throw new Error("no files in this test worker");
			},
			...parts.worker,
		});
	});
}

export type TestHost = {
	readonly host: Host;
	readonly errors: readonly unknown[];
	root<T>(fn: (ctx: Ctx) => T | Promise<T>, options?: { readonly principal?: P2Principal }): Promise<T>;
	/** A memory-linked client whose principal is stamped by the bare host, just as by the server. */
	client(principal: P2Principal): Host;
	/** `client`, once it loaded `facets` (TUI facets, say). */
	clientWith(principal: P2Principal, facets: readonly PluginFacet<P2Principal>[]): Promise<Host>;
	/** Reloads the host with `facets` in place of the loaded ones (the same base and stubs); rejects a failed plugin. */
	reload(facets: readonly Facet[]): Promise<void>;
	close(): Promise<void>;
};

/**
 * One or more facets without processes, HTTP, SQLite or a provider, on a host at `address` (the server by default)
 * with the base registries of its kind. Install only the stubs these facets need. `principal`: whom `root` acts as.
 */
export async function testHost(options: {
	readonly address?: Address;
	readonly kind?: "server" | "worker";
	readonly principal?: P2Principal;
	readonly facets: readonly Facet[];
	readonly stubs?: readonly Stub[];
	/** Runs before `load`: routes (`host.route`) are declared there. */
	readonly beforeLoad?: (host: Host) => void;
	/** The server's natives (a server host): no workers and no resource options unless given. */
	readonly server?: Partial<ServerParts>;
}): Promise<TestHost> {
	const errors: unknown[] = [];
	const clients: Host[] = [];
	const worker = options.kind === "worker";
	const host = createHost({
		address: options.address ?? Server(),
		principal: worker ? HOST : SERVER,
		onError: reportTo((error) => errors.push(error)),
	});
	const base = defineFacet((facet, self) => {
		if (worker) serveWorkerRegistries(facet);
		else {
			serveServerRegistries(facet);
			serveNative(facet, ServerNatives);
			self.contribute(ServerNatives, {
				resourceOptions: {},
				workers: NO_WORKERS,
				root: (fn, context) => host.root(fn, context),
				...options.server,
			});
		}
		for (const stub of options.stubs ?? []) serveStub(facet, stub);
	});
	options.beforeLoad?.(host);
	const plugins = (facets: readonly Facet[]) => [
		{ name: "@p2/test-base", facet: base },
		...facets.map((facet, index) => ({ name: `test-facet-${index}`, facet })),
	];
	try {
		const report = await host.load(plugins(options.facets), TEST);
		const failed = report.failed[0];
		if (failed) throw failed.error;
	} catch (error) {
		await host.close(TEST);
		throw error;
	}
	const connect = (principal: P2Principal): Host => {
		const [down, up] = memoryLinkPair();
		host.accept(down, { principal }, TEST);
		const client = createHost({ onError: reportTo((error) => errors.push(error)) });
		client.connect(up, { principal: worker ? HOST : SERVER }, TEST);
		clients.push(client);
		return client;
	};
	let closing: Promise<void> | undefined;
	return {
		host,
		errors,
		root: (fn, rootOptions) =>
			host.root(async (ctx) => fn(ctx), TEST, { principal: rootOptions?.principal ?? options.principal }),
		client: (principal) => {
			const client = connect(principal);
			void client.load([], TEST);
			return client;
		},
		clientWith: async (principal, facets) => {
			const client = connect(principal);
			const report = await client.load(facets, TEST);
			if (report.failed[0]) throw report.failed[0].error;
			return client;
		},
		reload: async (facets) => {
			const report = await host.reload(plugins(facets), TEST);
			if (report.failed[0]) throw report.failed[0].error;
		},
		close: () => {
			closing ??= (async () => {
				for (const client of clients) await client.close(TEST);
				await host.close(TEST);
			})();
			return closing;
		},
	};
}

/** What `settled` and `until` follow: a state member, a derive, a registry value, a reference's state. */
export type Followed<T> = Watchable<T> | NativeWatchable<T>;

/** Resolves with a defined value after a quiet publication window, not after future/background work finishes.
 * Await the producing call/reference first; use `until` for an expected revision or asynchronous transition.
 */
export function settled<T>(source: Followed<T>, quietMs = 25, timeoutMs = 20_000): Promise<Exclude<T, undefined>> {
	return new Promise((resolve, reject) => {
		let stop: (() => void) | undefined;
		let quiet: ReturnType<typeof setTimeout> | undefined;
		const timeout = setTimeout(() => {
			clearTimeout(quiet);
			stop?.();
			reject(new Error(`state did not settle after ${timeoutMs} ms`));
		}, timeoutMs);
		stop = follow(source, (value) => {
			clearTimeout(quiet);
			if (value === undefined) return;
			quiet = setTimeout(() => {
				clearTimeout(timeout);
				stop?.();
				resolve(value as Exclude<T, undefined>);
			}, quietMs);
		});
	});
}

/** Asserts a stable ChordError code rather than matching an implementation's error wording. */
export async function expectChord(promise: Promise<unknown>, code: ChordErrorCode): Promise<ChordError> {
	try {
		await promise;
	} catch (error) {
		assert(
			isChordError(error, code) || (error as { code?: unknown } | undefined)?.code === code,
			`expected ChordError ${code}, got ${String(error)}`,
		);
		return error as ChordError;
	}
	assert.fail(`expected ChordError ${code}, promise resolved`);
}

/**
 * The error of `ref`'s first failure or end, whatever its cause: a type nobody serves leaves a hold `failed { waiting }`
 * (it would bind once served), which `whenLive` keeps waiting through.
 */
export async function failureOf(ref: HeldRef): Promise<ChordError> {
	const state = await until(ref.state, (value) => value.kind === "failed" || value.kind === "ended");
	return (
		state.kind === "ended" ? state.error : state.kind === "failed" ? state.cause.error : undefined
	) as ChordError;
}

/** Resolves with the first value of `source` that satisfies `predicate` (following it meanwhile). */
export function until<T>(source: Followed<T>, predicate: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
	return new Promise((resolve, reject) => {
		let last: T | undefined;
		let done = false;
		const timer = setTimeout(() => {
			stop();
			reject(new Error(`timed out after ${timeoutMs} ms; last value: ${JSON.stringify(last)?.slice(0, 500)}`));
		}, timeoutMs);
		// `follow` may call at once, before `stop` exists.
		const stop = follow(source, (value) => {
			last = value;
			if (done || !predicate(value)) return;
			done = true;
			clearTimeout(timer);
			queueMicrotask(() => stop());
			resolve(value);
		});
	});
}

export async function poll(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 20_000,
	what = "condition",
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
export type HttpOptions = { method?: string; headers?: Record<string, string>; body?: string | Buffer };

/** An HTTP request to the fixture's server (any Host, cookie and body). */
export function http(port: number, path: string, options: HttpOptions = {}): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

/** The server's current web bundle manifest, as `headers` (a cookie or tunnel Host) may read it. */
export async function webBundle(port: number, headers: Record<string, string> = {}): Promise<WebManifest> {
	const response = await http(port, WEB_MANIFEST_PATH, { headers });
	assert.equal(response.status, 200, response.body);
	return JSON.parse(response.body) as WebManifest;
}
