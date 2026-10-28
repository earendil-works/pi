import { ChildReloads, reconcileChild, runClusterReload } from "./cluster.ts";
import { type AcceptOptions, Connection, type LinkOptions, type RelayRef } from "./connection.ts";
import {
	type AnyContract,
	bind,
	contractFromDescription,
	type InputOf,
	type LocalContract,
	type LocalDef,
	placedOn,
	placementText,
	type Ref,
	type RemoteContract,
	type RemoteDef,
	resolveHost,
} from "./contract.ts";
import { ChordError, invalid, runAll } from "./errors.ts";
import type { Link } from "./link.ts";
import {
	awaitReady,
	CtxImpl,
	type Decls,
	type Factory,
	type HostCore,
	hostLifetime,
	makeService,
	ObjectImpl,
	type RefCore,
	RefImpl,
	type RefOwner,
	type ServeOptions,
	type ServeOptionsFor,
	type Service,
} from "./object.ts";
import { enqueue } from "./publish.ts";
import type { Registry, RegistryTable, RegistryView } from "./registry.ts";
import { type ReloadOptions, type ReloadReport, runReload } from "./reload.ts";
import { RemoteBinding, RemoteRef } from "./remote.ts";
import { canonicalIdentity, canonicalJson, deepEqual, normalize } from "./schema.ts";
import type { Ctx, GetOptions } from "./types.ts";
import type { Frame } from "./wire.ts";

/**
 * Registers a factory for a type. Overloaded on the contract's definition (not the contract type) so TypeScript
 * keeps literal `variant`s in factory returns. `P` is the app's principal type (see `createHost`).
 */
export interface Serve<P = unknown> {
	<D extends RemoteDef>(
		type: RemoteContract<D>,
		factory: Factory<RemoteContract<D>, P>,
		options?: ServeOptionsFor<RemoteContract<D>>,
	): void;
	<D extends LocalDef>(
		type: LocalContract<D>,
		factory: Factory<LocalContract<D>, P>,
		options?: ServeOptionsFor<LocalContract<D>>,
	): void;
}

type AnyServe = (type: AnyContract, factory: Factory<AnyContract>, options?: ServeOptions) => void;

/**
 * What a facet's `setup` gets. `serve` registers types; `root` and `registry` give the facet's code that is not a
 * Chord method, listener or task (Durable tools and hooks, callbacks of native libraries) access to its own host,
 * so plugins never need a process-global host. Both may be kept and used after `setup` returns.
 */
export interface FacetApi<P = unknown> {
	readonly serve: Serve<P>;
	/** The host's name (`server`, `session:S1`, ...). */
	readonly name: string;
	/** Starts a root on the facet's host (in its current code version at call time). */
	root<T>(fn: (ctx: Ctx<P>) => T | Promise<T>, options?: RootOptions<P>): Promise<T>;
	/** The facet's host's registry view (`get(key, ctx)` reads the table of `ctx.codeVersion`). */
	registry<V>(registry: Registry<V>): RegistryView<V>;
	/**
	 * Aborted when this run of the facet is no longer installed: a reload that replaced or removed it committed, the reload
	 * that loaded it aborted, or the host closed. While a reload prepares, the installed and the candidate run are both
	 * live.
	 */
	readonly signal: AbortSignal;
}

/** What a facet module exports (default export): the code that serves its types on one host kind. */
export interface FacetDefinition<P = unknown> {
	/** Contract tokens this facet consumes; checked against providers at reload. */
	readonly uses?: readonly AnyContract[];
	setup(api: FacetApi<P>): void;
}

/** A named facet. Modules are named by their URL; reloading a facet replaces everything it served. */
export interface Facet<P = unknown> extends FacetDefinition<P> {
	readonly name: string;
}

/** `defineFacet<P>(…)`: an app passes its principal type, so factories and contexts see `P`. */
export const defineFacet = <P = unknown>(
	setup: (api: FacetApi<P>) => void,
	options: { readonly uses?: readonly AnyContract[] } = {},
): FacetDefinition<P> => ({ setup, uses: options.uses });

/** Imports facet modules (fresh copies on every call) and names them by module URL. */
export type FacetLoader = (modules: readonly (string | URL)[]) => Promise<Facet[]>;

/** A facet object, or a module (path or URL) whose default export is a FacetDefinition. */
export type PluginRef<P = unknown> = Facet<P> | string | URL;

const isFacet = (ref: PluginRef): ref is Facet => typeof ref === "object" && !(ref instanceof URL);

/**
 * `P` is the app's principal type: who a caller is, JSON-serializable. Chord never makes one up: the app supplies the
 * host's own (`self`), the one its parent's own requests act as (`connect`), the ones links act as (`accept`) and the
 * ones routed hosts act as (`Route.principal`).
 */
export interface HostOptions<P = unknown> {
	readonly name?: string;
	/**
	 * The principal of the host's own code: roots it starts, code inside its objects, and its `lifetime: "host"` objects.
	 * Compared by `principalKey`, so an equal principal from elsewhere reaches the same objects. Not used to infer `P`:
	 * pass the app's type as `createHost<P>(…)`.
	 */
	readonly self: NoInfer<P>;
	/** Maps a principal to its object key (should include connection provenance and grant revision). */
	readonly principalKey?: (principal: P) => string;
	/** Validates every cell write and exposed state value against its schemas. */
	readonly dev?: boolean;
	/** Errors from background work (disposal, listeners, tasks). Defaults to console.error. */
	readonly onError?: (error: unknown) => void;
	/**
	 * Milliseconds a reload waits for an object's aborted tasks to finish before it starts their replacements anyway
	 * (reported). Default 5000.
	 */
	readonly taskStopDeadline?: number;
	/**
	 * Milliseconds an activation (or a reload's prepare) waits for its references to be ready and hydrated, and an
	 * awaited `get` for its reference, before failing with `unavailable/ready_timeout`. Default 60000.
	 */
	readonly readyTimeout?: number;
	/**
	 * Consumer-side linger of remote references: when the last reference to a remote object is released, its binding
	 * stays held, and hydrated, for `types[typeName]` milliseconds, so a reference taken again meanwhile costs nothing
	 * on the link. At most `cap` bindings (default 4) linger; beyond, the least recently released go first. Types not
	 * listed do not linger. (The provider's own `serve(…, { linger })` keeps its object after the last reference.)
	 */
	readonly linger?: { readonly types?: Readonly<Record<string, number>>; readonly cap?: number };
	/** Needed for `load`/`reload` with modules; `nodeLoader` from loader.ts in Node. */
	readonly loader?: FacetLoader;
	/** `client` (browser): never a reload participant, never carries roots or code versions. Default `host`. */
	readonly kind?: "host" | "client";
	/** The link to this host's parent (server). Can also be set later with `connect`. */
	readonly upstream?: { readonly link: Link } & ConnectOptions<P>;
}

/** `connect` options: the link's, and the principal its parent's own requests act as. */
export interface ConnectOptions<P = unknown> extends LinkOptions {
	/** What a request from the parent acts as when the parent does not forward its caller's principal (its own code). */
	readonly principal: P;
}

/** Where requests for hosts named `prefix…` go (on the server). */
export interface Route<P = unknown> {
	/** Checked before resolving (or spawning) and again after: grants may change meanwhile. */
	authorize(principal: P, hostName: string): boolean | Promise<boolean>;
	/** A link to the host, spawned if needed. */
	resolve(hostName: string): Promise<Link>;
	/** The principal the resolved host acts as when it calls back. */
	readonly principal: (hostName: string) => P;
}

/** Fields a principal must have, equal (`deepEqual`), for an `invalidatePrincipal` pattern. */
export type PrincipalPattern<P> = P extends object
	? { readonly [K in keyof P]?: P[K] }
	: Readonly<Record<string, unknown>>;

/** `invalidatePrincipal` matches: a predicate (this host only), or a pattern (fields that must be equal; propagates). */
export type PrincipalMatch<P = unknown> = ((principal: P) => boolean) | PrincipalPattern<P>;

export interface RootOptions<P = unknown> {
	readonly principal?: P;
	readonly signal?: AbortSignal;
	/** Start the root in a retained code version (links carry code versions). Defaults to the current code version. */
	readonly codeVersion?: number;
}

export interface LoadOptions {
	/**
	 * Await the activation of the `lifetime: "host"` objects the facets serve (default true). False starts them but
	 * leaves readiness to `host.ready()` (a child host whose objects need its parent, which admits it only later).
	 */
	readonly awaitHostObjects?: boolean;
}

export interface Host<P = unknown> {
	readonly name: string;
	readonly codeVersion: number;
	readonly previousCodeVersion: number | undefined;
	readonly serve: Serve<P>;
	/** Installs synchronously, then awaits this facet's host objects unless `awaitHostObjects` is false. */
	install(facet: Facet<P>, options?: LoadOptions): Promise<void>;
	/** Installs all facets before awaiting their host objects; referenced objects are created when first referenced. */
	load(plugins: readonly PluginRef<P>[], options?: LoadOptions): Promise<void>;
	/** Awaits the host objects present at call time, including those started by `serve` or deferred loads. */
	ready(): Promise<void>;
	/**
	 * A reference held until `release()`. Resolves once it is ready: live, with every state member of its variant
	 * (unless `state: false`). Rejects with the activation error, `aborted` (`signal`), or `unavailable/ready_timeout`
	 * after `readyTimeout`; the reference is released then.
	 */
	get<C extends AnyContract>(
		type: C,
		input: InputOf<C>,
		options?: GetOptions<P> & { readonly signal?: AbortSignal },
	): Promise<Ref<C>>;
	/**
	 * The same reference, synchronously, possibly still `loading`: for UI runtimes that render its status (hooks, a
	 * TUI watch). Its state members throw `not_ready` until it is live.
	 */
	hold<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions<P>): Ref<C>;
	root<T>(fn: (ctx: Ctx<P>) => T | Promise<T>, options?: RootOptions<P>): Promise<T>;
	registry<V>(registry: Registry<V>): RegistryView<V>;
	/**
	 * Force-disposes every object whose principal matches (never the host's own principal), re-stamps or closes
	 * matching links, and propagates pattern matches to child hosts.
	 */
	invalidatePrincipal(match: PrincipalMatch<P>): Promise<void>;
	/** Accepts a child link (a worker or a browser); requests on it act as `options.principal`. */
	accept(link: Link, options: AcceptOptions<P>): void;
	/**
	 * Sets (or replaces, after a reconnect) the link to this host's parent; remote references re-hold over it. The
	 * parent's own requests act as `options.principal`; requests it relays act as the principal it forwards.
	 */
	connect(link: Link, options: ConnectOptions<P>): void;
	route(prefix: string, route: Route<P>): void;
	/** Reloads the given facets (modules are re-imported); facets not listed keep running unchanged. */
	reload(plugins: readonly PluginRef<P>[], options?: ReloadOptions): Promise<ReloadReport>;
	close(): Promise<void>;
}

export interface CodeVersionState {
	readonly id: number;
	readonly services: Map<string, Service>;
	tables: ReadonlyMap<string, RegistryTable<unknown>>;
	/** Running roots with the number of their calls running here. */
	readonly roots: Map<string, number>;
	/** Aborts every root of this code version (forced retirement). */
	readonly abort: AbortController;
}

const EMPTY_TABLE: RegistryTable<never> = new Map<string, never>();

/** A host whose principals are `P` (the app's type; `unknown` if not given). */
export function createHost<P = unknown>(options: HostOptions<P>): Host<P> {
	return new HostImpl(options as HostOptions) as unknown as Host<P>;
}

export class HostImpl implements Host, HostCore {
	readonly name: string;
	readonly dev: boolean;
	readonly principal: unknown;
	inFactory = 0;
	failed: unknown;
	readonly objects = new Map<string, ObjectImpl>();
	readonly codeVersions = new Map<number, CodeVersionState>();
	readonly facets = new Map<string, Facet>();
	/** The host's own references to its `lifetime: "host"` objects, by type name. */
	readonly hostObjects = new Map<string, RefCore>();
	readonly kind: "host" | "client";
	readonly connections = new Set<Connection>();
	upstream: Connection | undefined;
	/** Shared bindings of this host's remote references, by key (re-held after an upstream reconnect). */
	readonly bindings = new Map<string, RemoteBinding>();
	/** Bindings without references that linger, least recently released first. */
	readonly #lingering = new Map<string, RemoteBinding>();
	readonly #lingerTypes: Readonly<Record<string, number>>;
	readonly #lingerCap: number;
	#originSeq = 0;
	readonly #routes = new Map<string, Route>();
	readonly #childReloads = new ChildReloads(this);
	/** Child facet modules by host-name prefix, from every committed cluster reload (for reconciling children). */
	remoteModules: Record<string, string[]> = {};
	/** Removal tombstones also reconcile children that connected during a transaction. */
	remoteRemoved: Record<string, string[]> = {};
	/** Highest code version the parent has retired. */
	#retireAllowed = 0;
	/** Roots that came over a link, by the link they came from. */
	/** Foreign roots (started on another host), by the links they came over. */
	readonly #foreign = new Map<string, Set<Connection>>();
	/** Roots started on this host that have not ended. */
	readonly #local = new Set<string>();
	readonly #incarnation = Math.random().toString(36).slice(2, 8);
	/** Links each root's calls went out on. */
	readonly #rootLinks = new Map<string, Set<Connection>>();
	current: CodeVersionState;
	previous: CodeVersionState | undefined;
	/** The code version a running reload will commit; new types activated during prepare install their implementation for it. */
	pending: CodeVersionState | undefined;
	/** Activations of these types wait (reload gate). */
	/** Types behind a reload gate: new objects of these types are rejected `upgrade_conflict` until commit/abort. */
	gating: ReadonlySet<string> | undefined;
	reloading = false;
	readonly taskStopDeadline: number;
	readonly readyTimeout: number;
	readonly #principalKey: (principal: unknown) => string;
	/** `principalKey(self)`: an equal principal is the host's own, whatever object carries it. */
	readonly #selfKey: string;
	/** Called when a root ends, the parent allows a retirement, or the previous code version retires. */
	readonly #retirementWatchers = new Set<() => void>();
	/** Child hosts whose hello arrived while a reload ran: synced or reconciled once it ends. */
	readonly #deferredHellos = new Map<Connection, number>();
	/** Resolved when the running reload ends. */
	readonly #reloadWaiters: (() => void)[] = [];
	/** Aborted when the installed run of a facet (by name) is replaced, removed, or the host closes. */
	readonly #facetRuns = new Map<string, AbortController>();
	readonly #onError: (error: unknown) => void;
	readonly #loader: FacetLoader | undefined;
	readonly #dying = new Map<string, ObjectImpl>();
	readonly #touches = new Map<string, Set<ObjectImpl>>();
	readonly #order = new Map<string, Map<string, number>>();
	readonly #subscribers = new Map<string, Set<(table: RegistryTable<unknown>, codeVersion: number) => void>>();
	#codeVersionSeq = 1;
	#rootSeq = 0;

	constructor(options: HostOptions) {
		this.name = options.name ?? "host";
		this.dev = options.dev ?? false;
		if (!("self" in options)) throw new TypeError("createHost needs `self`: the principal of the host's own code");
		this.principal = options.self;
		this.#principalKey = options.principalKey ?? canonicalJson;
		this.#selfKey = this.#principalKey(options.self);
		this.#onError = options.onError ?? ((error) => console.error("chord:", error));
		this.#loader = options.loader;
		this.taskStopDeadline = options.taskStopDeadline ?? 5000;
		this.readyTimeout = options.readyTimeout ?? 60_000;
		this.#lingerTypes = options.linger?.types ?? {};
		this.#lingerCap = options.linger?.cap ?? 4;
		this.current = {
			id: this.#codeVersionSeq,
			services: new Map(),
			tables: new Map(),
			roots: new Map(),
			abort: new AbortController(),
		};
		this.codeVersions.set(this.current.id, this.current);
		this.kind = options.kind ?? "host";
		if (options.upstream !== undefined) this.connect(options.upstream.link, options.upstream);
	}

	/** Whether `principal` is the host's own: the same key as `self`. */
	isSelf(principal: unknown): boolean {
		return principal === this.principal || this.#principalKey(principal) === this.#selfKey;
	}

	get codeVersion(): number {
		return this.current.id;
	}

	get previousCodeVersion(): number | undefined {
		return this.previous?.id;
	}

	/** Allocates the next code version id, or adopts one issued by the coordinating server. */
	nextCodeVersionId(given?: number): number {
		if (given !== undefined && given <= this.current.id)
			throw new Error(`code version ${given} is not newer than ${this.current.id}`);
		this.#codeVersionSeq = given ?? this.#codeVersionSeq + 1;
		return this.#codeVersionSeq;
	}

	report(error: unknown): void {
		this.#onError(error);
	}

	// ─── serving ───

	readonly serve: Serve = ((type, factory, options = {}) => {
		if (this.reloading) throw new Error("host.serve during a reload; serve from a facet passed to reload()");
		this.serveInto(this.current.services, makeService(type, factory, options, ""));
		if (options.lifetime === "host") this.startHostObject(this.current.services.get(type.name)!);
	}) satisfies AnyServe as Serve;

	install(facet: Facet, options: LoadOptions = {}): Promise<void> {
		if (this.reloading) throw new Error("host.install during a reload");
		if (this.facets.has(facet.name)) throw new Error(`facet ${facet.name} is already installed; use reload()`);
		const added: Service[] = [];
		const run = new AbortController();
		try {
			facet.setup(
				this.facetApi(
					((type, factory, options = {}) => {
						const service = makeService(type, factory, options, facet.name);
						this.serveInto(this.current.services, service);
						added.push(service);
					}) satisfies AnyServe as Serve,
					run.signal,
				),
			);
		} catch (error) {
			run.abort(error);
			throw error;
		}
		this.facets.set(facet.name, facet);
		this.facetRunChanged(facet.name, run);
		const refs = added.filter(hostLifetime).map((service) => this.startHostObject(service));
		return options.awaitHostObjects === false ? Promise.resolve() : this.#hostObjectsReady(refs);
	}

	async load(plugins: readonly PluginRef[], options: LoadOptions = {}): Promise<void> {
		const facets = await this.resolve(plugins);
		// No await between installs: a host object's factory may consume a type served by a later facet.
		await Promise.all(facets.map((facet) => this.install(facet, options)));
	}

	ready(): Promise<void> {
		return this.#hostObjectsReady(this.hostObjects.values());
	}

	#hostObjectsReady(refs: Iterable<RefCore>): Promise<void> {
		const ready = Promise.all([...refs].map((ref) => ref.ready)).then(() => {});
		// Ignoring install's return still reports through onError without an unhandled rejection.
		ready.catch(() => {});
		return ready;
	}

	/** Turns plugin references into facets, importing modules through the loader. */
	async resolve(plugins: readonly PluginRef[]): Promise<Facet[]> {
		const modules = plugins.filter((ref): ref is string | URL => !isFacet(ref));
		if (modules.length > 0 && this.#loader === undefined) {
			throw new Error(
				"loading modules needs createHost({ loader }), e.g. nodeLoader from @earendil-works/chord/node",
			);
		}
		const loaded = modules.length > 0 && this.#loader !== undefined ? await this.#loader(modules) : [];
		return plugins.map((ref) => (isFacet(ref) ? ref : loaded.shift()!));
	}

	facetApi(serve: Serve, signal: AbortSignal): FacetApi {
		return {
			serve,
			name: this.name,
			root: (fn, options) => this.root(fn, options),
			registry: (registry) => this.registry(registry),
			signal,
		};
	}

	/** The installed run of facet `name` is now `run` (or none): the run it replaces is aborted. */
	facetRunChanged(name: string, run: AbortController | undefined): void {
		const replaced = this.#facetRuns.get(name);
		if (run === undefined) this.#facetRuns.delete(name);
		else this.#facetRuns.set(name, run);
		if (replaced !== run) replaced?.abort(new ChordError("gone", `facet ${name} was replaced or removed`));
	}

	serveInto(services: Map<string, Service>, service: Service): void {
		if (services.has(service.contract.name)) throw new Error(`${service.contract.name} is already served`);
		const placement = service.contract.description.host;
		if (placement !== undefined && !placedOn(placement, this.name)) {
			throw new TypeError(
				`${service.contract.name} is declared for ${placementText(placement)}, but ${this.name} serves it`,
			);
		}
		services.set(service.contract.name, service);
	}

	startHostObject(service: Service): RefCore {
		const ref = this.acquire(service.contract, {}, undefined, "host");
		this.hostObjects.set(service.contract.name, ref);
		ref.ready.catch((error: unknown) => this.report(error));
		return ref;
	}

	// ─── HostCore ───

	currentCodeVersion(): number {
		return this.current.id;
	}

	hasCodeVersion(codeVersion: number): boolean {
		return this.codeVersions.has(codeVersion);
	}

	*retainedCodeVersions(): Iterable<readonly [number, ReadonlyMap<string, Service>]> {
		for (const [id, state] of this.codeVersions) yield [id, state.services];
		if (this.pending !== undefined) yield [this.pending.id, this.pending.services];
	}

	pendingCodeVersion(): number | undefined {
		return this.pending?.id;
	}

	/** The current code for a type; a type a running reload adds is served from the pending code version. */
	service(typeName: string): Service | undefined {
		return this.current.services.get(typeName) ?? this.pending?.services.get(typeName);
	}

	addressOf(type: AnyContract, input: unknown, principal: unknown, candidate = false): string {
		const elsewhere = this.#elsewhere(type, input);
		if (elsewhere !== undefined) return this.#remoteKey(type, elsewhere.input, principal);
		const service = this.#bindingService(type.name, candidate);
		if (service === undefined) throw unknownType(type.name, this.name);
		return this.#locate(service, input, principal).address;
	}

	/**
	 * Where an object of a remote type lives when that is another host: its name and the input normalized with the
	 * caller's contract (the placement is read from it). `undefined`: here (and every local type).
	 */
	#elsewhere(type: AnyContract, input: unknown): { readonly at: string; readonly input: unknown } | undefined {
		const placement = type.description.host;
		if (type.scope !== "remote" || placement === undefined) return undefined;
		const normalized = normalize(type.input, input, `${type.name} input`);
		const at = resolveHost(type.name, placement, normalized);
		return at === this.name ? undefined : { at, input: normalized };
	}

	/**
	 * The address of `input` for `principal`, normalized. A `lifetime: "host"` type has one object: the empty input, for
	 * the host principal, whoever asks; another input is invalid.
	 */
	#locate(service: Service, input: unknown, principal: unknown) {
		const { name, input: schema } = service.contract;
		const normalized = normalize(schema, input, `${name} input`);
		const identity = canonicalIdentity(schema, normalized);
		if (hostLifetime(service)) {
			if (identity !== canonicalIdentity(schema, normalize(schema, {}, `${name} input`)))
				throw invalid("input", `${name} has lifetime "host": its one object has the empty input`);
			principal = this.principal;
		}
		return { address: `${name}\u0000${identity}\u0000${this.#principalPart(principal)}`, normalized, principal };
	}

	#principalPart(principal: unknown): string {
		return this.isSelf(principal) ? "host" : `p:${this.#principalKey(principal)}`;
	}

	/**
	 * The key of a remote binding: type, input identity (fields equal to their defaults omitted, as for local objects),
	 * principal key and the consumer's contract fingerprint. No host name: the type and the input decide where it lives.
	 */
	#remoteKey(type: AnyContract, normalized: unknown, principal: unknown): string {
		const identity = canonicalIdentity(type.input, normalized);
		return `@${type.name}\u0000${identity}\u0000${this.#principalPart(principal)}\u0000${type.fingerprint}`;
	}

	acquire(
		type: AnyContract,
		input: unknown,
		options: GetOptions | undefined,
		owner: RefOwner,
		from?: ObjectImpl,
		candidate = false,
	): RefCore {
		const elsewhere = this.#elsewhere(type, input);
		if (elsewhere !== undefined) return this.#acquireRemote(type, elsewhere.at, elsewhere.input, options, owner);
		const service = this.#bindingService(type.name, candidate);
		if (service === undefined) throw unknownType(type.name, this.name);
		bind(service.contract, service.options.accepts, type);
		const { address, normalized, principal } = this.#locate(service, input, options?.principal ?? this.principal);
		// The provider's own placement decides, never where a request says it is going (a client picks that).
		const placement = service.contract.description.host;
		if (placement !== undefined && resolveHost(type.name, placement, normalized) !== this.name) {
			throw invalid(
				"placement",
				`${type.name} with this input lives on ${resolveHost(type.name, placement, normalized)}, not ${this.name}`,
			);
		}
		let object = this.objects.get(address);
		if (from !== undefined && object !== undefined && (object === from || reaches(object, from))) {
			throw invalid("cycle", `${from.address} -> ${address} would create a ref cycle`);
		}
		if (object === undefined) {
			if (this.gating?.has(type.name)) {
				throw new ChordError("upgrade_conflict", `${type.name} is being upgraded; retry`, { reason: "gate" });
			}
			const dying = this.#dying.get(address);
			if (dying?.status === "disposed") this.#dying.delete(address);
			object = new ObjectImpl(this, {
				address,
				typeName: type.name,
				input: normalized,
				principal,
				hostLifetime: hostLifetime(service),
			});
			this.objects.set(address, object);
			// A new object for an address still being disposed waits for that cleanup (exclusive resources).
			object.start(dying?.status === "disposing" ? dying.dispose(false) : undefined);
		}
		const ref = new RefImpl(object, type, owner);
		object.addRef(ref);
		return ref;
	}

	forget(object: ObjectImpl): void {
		if (this.objects.get(object.address) === object) this.objects.delete(object.address);
		if (object.status === "disposing") this.#dying.set(object.address, object);
	}

	disposed(object: ObjectImpl): void {
		if (this.#dying.get(object.address) === object) this.#dying.delete(object.address);
	}

	touch(rootId: string, object: ObjectImpl): void {
		let touched = this.#touches.get(rootId);
		if (touched === undefined) {
			touched = new Set();
			this.#touches.set(rootId, touched);
		}
		touched.add(object);
	}

	// ─── roots ───

	async root<T>(fn: (ctx: Ctx) => T | Promise<T>, options: RootOptions = {}): Promise<T> {
		// The incarnation keeps root ids unique across restarts of a host with the same name.
		const rootId = `${this.name}#${this.#incarnation}:${++this.#rootSeq}`;
		this.#local.add(rootId);
		return this.joinRoot(rootId, options.codeVersion ?? this.current.id, fn, options);
	}

	/**
	 * Runs `fn` inside root `rootId` of `codeVersion`. A root counts as running here (for retirement) while any of its
	 * calls runs here. A root that started here ends when its last call here settles, even if it went out and came back
	 * over a link meanwhile. A foreign root (started elsewhere, arriving `from` a link) keeps its leases on objects
	 * until every link it came over announced its end (`root_end`) or closed, so its re-entry stays grandfathered.
	 */
	async joinRoot<T>(
		rootId: string,
		codeVersionId: number,
		fn: (ctx: Ctx) => T | Promise<T>,
		options: { readonly principal?: unknown; readonly signal?: AbortSignal; readonly from?: Connection } = {},
	): Promise<T> {
		const codeVersion = this.codeVersions.get(codeVersionId);
		if (codeVersion === undefined) {
			this.#local.delete(rootId);
			throw new ChordError("superseded", `code version ${codeVersionId} is not retained by ${this.name}`);
		}
		if (options.from !== undefined && !this.#local.has(rootId)) {
			let links = this.#foreign.get(rootId);
			if (links === undefined) {
				links = new Set();
				this.#foreign.set(rootId, links);
			}
			links.add(options.from);
		}
		codeVersion.roots.set(rootId, (codeVersion.roots.get(rootId) ?? 0) + 1);
		const ctx = new CtxImpl(this, {
			// Forced retirement aborts what still runs on a code version before closing what only it used.
			signals:
				options.signal === undefined ? [codeVersion.abort.signal] : [options.signal, codeVersion.abort.signal],
			rootId,
			codeVersion: codeVersion.id,
			principal: options.principal ?? this.principal,
		});
		try {
			return await fn(ctx);
		} finally {
			ctx.close();
			const count = (codeVersion.roots.get(rootId) ?? 1) - 1;
			if (count > 0) codeVersion.roots.set(rootId, count);
			else {
				codeVersion.roots.delete(rootId);
				if (!this.#foreign.has(rootId)) this.endRoot(rootId);
				this.maybeRetire();
				this.#retirementChanged();
			}
		}
	}

	/** Remembers that calls of `rootId` went out on `connection`, which must hear when the root ends. */
	rootSent(rootId: string, connection: Connection): void {
		let links = this.#rootLinks.get(rootId);
		if (links === undefined) {
			links = new Set();
			this.#rootLinks.set(rootId, links);
		}
		links.add(connection);
	}

	/** A root ended (here, or announced by its origin): end its leases and tell the links it went out on. */
	endRoot(rootId: string): void {
		this.#local.delete(rootId);
		this.#foreign.delete(rootId);
		for (const object of this.#touches.get(rootId) ?? []) object.rootEnded(rootId);
		this.#touches.delete(rootId);
		for (const connection of this.#rootLinks.get(rootId) ?? []) connection.send({ t: "root_end", rootId });
		this.#rootLinks.delete(rootId);
	}

	/**
	 * `from` announced the end of a foreign root (or closed). Honored only if the root came over `from`: a peer cannot
	 * end leases of roots it never carried. The root ends when no link that brought it remains.
	 */
	foreignRootEnded(rootId: string, from: Connection): void {
		const links = this.#foreign.get(rootId);
		if (links === undefined || !links.delete(from) || links.size > 0) return;
		const running = [...this.codeVersions.values()].some((codeVersion) => codeVersion.roots.has(rootId));
		// Still running here (a call in flight): the lease ends when it settles.
		if (running) this.#foreign.delete(rootId);
		else this.endRoot(rootId);
	}

	/**
	 * Retires the previous code version once no local roots of it remain. A child also waits for its parent to retire
	 * it: roots span hosts, and an old root on the server may still call in.
	 */
	maybeRetire(): void {
		if (this.retirable()) this.retire();
	}

	/** The previous code version has no roots left here and, on a child host, the parent has retired it. */
	retirable(): boolean {
		const previous = this.previous;
		if (previous === undefined || previous.roots.size > 0) return false;
		return this.kind === "client" || this.upstream === undefined || previous.id <= this.#retireAllowed;
	}

	allowRetire(codeVersion: number): void {
		this.#retireAllowed = Math.max(this.#retireAllowed, codeVersion);
		this.maybeRetire();
		this.#retirementChanged();
	}

	/** Calls `watcher` whenever a root ends, the parent allows a retirement, or a code version retires. */
	watchRetirement(watcher: () => void): () => void {
		this.#retirementWatchers.add(watcher);
		return () => this.#retirementWatchers.delete(watcher);
	}

	#retirementChanged(): void {
		for (const watcher of [...this.#retirementWatchers]) watcher();
	}

	/**
	 * Tells a child that is now in step which code versions this host retired before: every id below the oldest one it
	 * retains (ids only grow). Without it, a child reconciled after those retirements would never hear a `retire` frame for
	 * its own previous code version and would wait for the retire deadline at every reload.
	 */
	announceRetired(connection: Connection): void {
		const retired = (this.previous ?? this.current).id - 1;
		if (retired > 0) connection.send({ t: "retire", codeVersion: retired });
	}

	/** Drops the previous code version: its implementations and the declarations only it used. */
	retire(): void {
		const previous = this.previous;
		if (previous === undefined) return;
		this.previous = undefined;
		this.codeVersions.delete(previous.id);
		for (const object of [...this.objects.values()]) this.retireImplementation(object, previous.id);
		for (const connection of this.connections) {
			if (connection.role === "downstream" && connection.peer?.kind === "host")
				connection.send({ t: "retire", codeVersion: previous.id });
		}
		this.#retirementChanged();
	}

	/**
	 * Drops an object's implementation for `codeVersion` and what only that implementation declared, in disposal order:
	 * resources close (reverse open order) before its references are released.
	 */
	retireImplementation(object: ObjectImpl, codeVersion: number): void {
		const installed = object.implementations.get(codeVersion);
		object.implementations.delete(codeVersion);
		if (installed === undefined || installed.decls === object.decls) return;
		const kept = object.allDecls();
		const keep = <T>(pick: (decls: Decls) => Iterable<T>): Set<T> =>
			new Set([...kept].flatMap((decls) => [...pick(decls)]));
		const refs = keep((decls) => decls.refs.values());
		const resources = keep((decls) => decls.resources.values());
		const derives = keep((decls) => decls.derives.values());
		for (const derived of installed.decls.derives.values()) if (!derives.has(derived)) derived.detach();
		const closing = [...installed.decls.resources.values()]
			.filter((resource) => !resources.has(resource))
			.sort((a, b) => object.openOrder.indexOf(b) - object.openOrder.indexOf(a));
		const releasing = [...installed.decls.refs.values()].filter((ref) => !refs.has(ref));
		object.refreshSchemas();
		runAll(
			[
				...closing.map((resource) => () => resource.close(object.openOrder)),
				...releasing.map((ref) => () => ref.release()),
			],
			`${object.address}: retiring code version ${codeVersion} failed`,
		).catch((error: unknown) => this.report(error));
	}

	// ─── registries ───

	registry<V>(registry: Registry<V>): RegistryView<V> {
		const table = (ctx?: Ctx): RegistryTable<V> => {
			const codeVersion = ctx === undefined ? this.current : this.codeVersions.get(ctx.codeVersion);
			if (codeVersion === undefined)
				throw new ChordError("superseded", `code version ${ctx?.codeVersion} is retired`);
			return (codeVersion.tables.get(registry.name) ?? EMPTY_TABLE) as RegistryTable<V>;
		};
		return {
			table,
			get: (key, ctx) => table(ctx).get(key),
			subscribe: (listener) => {
				let set = this.#subscribers.get(registry.name);
				if (set === undefined) {
					set = new Set();
					this.#subscribers.set(registry.name, set);
				}
				const wrapped = listener as (table: RegistryTable<unknown>, codeVersion: number) => void;
				set.add(wrapped);
				wrapped(table(), this.current.id);
				return () => set.delete(wrapped);
			},
		};
	}

	/** Builds registry tables from (object, declarations) pairs. Throws registry_conflict. */
	buildTables(entries: Iterable<readonly [ObjectImpl, Decls]>): Map<string, RegistryTable<unknown>> {
		const byRegistry = new Map<string, Map<string, { value: unknown; object: ObjectImpl }>>();
		for (const [object, decls] of entries) {
			for (const { registry, key, value } of decls.registrations.values()) {
				let entries = byRegistry.get(registry.name);
				if (entries === undefined) {
					entries = new Map();
					byRegistry.set(registry.name, entries);
				}
				const existing = entries.get(key);
				if (existing !== undefined && existing.object !== object && registry.conflict === "error") {
					throw invalid(
						"registry_conflict",
						`${registry.name}: ${key} registered by ${existing.object.address} and ${object.address}`,
					);
				}
				entries.set(key, { value, object });
				let order = this.#order.get(registry.name);
				if (order === undefined) {
					order = new Map();
					this.#order.set(registry.name, order);
				}
				if (!order.has(key)) order.set(key, order.size);
			}
		}
		const tables = new Map<string, RegistryTable<unknown>>();
		for (const [name, entries] of byRegistry) {
			const order = this.#order.get(name)!;
			const sorted = [...entries].sort(([a], [b]) => order.get(a)! - order.get(b)!);
			tables.set(name, new Map(sorted.map(([key, entry]) => [key, entry.value])));
		}
		return tables;
	}

	/**
	 * The service a reference binds against: the current one, or for a prepare rerun (`candidate`) the running reload's
	 * pending one, so consumer and provider of a breaking change can reload in one batch.
	 */
	#bindingService(typeName: string, candidate: boolean): Service | undefined {
		return (candidate ? this.pending?.services.get(typeName) : undefined) ?? this.service(typeName);
	}

	/** Live objects with their current declarations; objects waiting for a reload's commit only with `candidates`. */
	liveDecls(candidates = false): [ObjectImpl, Decls][] {
		return [...this.objects.values()]
			.filter((object) => object.status === "live" && (candidates || !object.deferredRuntime))
			.map((object) => [object, object.decls]);
	}

	checkRegistrations(object: ObjectImpl, decls: Decls): void {
		if (decls.registrations.size === 0) return;
		this.buildTables([...this.liveDecls().filter(([other]) => other !== object), [object, decls]]);
	}

	registriesChanged(including?: ObjectImpl): void {
		const entries = this.liveDecls().filter(([object]) => object !== including);
		if (including !== undefined) entries.push([including, including.decls]);
		this.installTables(this.current, this.buildTables(entries));
	}

	/** A commit failed midway: from now on this host admits no work (calls fail `unavailable/host_failed`). */
	fail(error: unknown): void {
		this.failed ??= error;
		this.report(error);
	}

	/** Installs tables for `codeVersion`; subscribers hear about changed tables of the current code version (all tables when `all`). */
	installTables(codeVersion: CodeVersionState, tables: Map<string, RegistryTable<unknown>>, all = false): void {
		const before = codeVersion.tables;
		codeVersion.tables = tables;
		if (codeVersion !== this.current) return;
		for (const [name, listeners] of this.#subscribers) {
			const next = tables.get(name) ?? EMPTY_TABLE;
			if (!all && sameTable(before.get(name) ?? EMPTY_TABLE, next)) continue;
			const current = [...listeners];
			enqueue(() => {
				for (const listener of current) {
					try {
						listener(next, codeVersion.id);
					} catch (error) {
						this.report(error);
					}
				}
			});
		}
	}

	// ─── public API ───

	async get<C extends AnyContract>(
		type: C,
		input: InputOf<C>,
		options?: GetOptions & { readonly signal?: AbortSignal },
	): Promise<Ref<C>> {
		const ref = this.acquire(type, input, options, "external");
		await awaitReady(ref, options?.signal === undefined ? [] : [options.signal], this.readyTimeout);
		return ref.proxy as Ref<C>;
	}

	hold<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions): Ref<C> {
		return this.acquire(type, input, options, "external").proxy as Ref<C>;
	}

	async invalidatePrincipal(match: PrincipalMatch): Promise<void> {
		const matches = typeof match === "function" ? match : (principal: unknown) => matchesPattern(match, principal);
		const reason = new ChordError("gone", "principal invalidated");
		// Links acting as a matching principal are re-stamped (if the acceptor can) or closed.
		for (const connection of [...this.connections]) {
			if (connection.role !== "downstream" || !matches(connection.principal)) continue;
			// Relays under the old principal close at once, including those still resolving their route.
			connection.revoke(connection.restamp?.(connection.principal));
		}
		// Patterns propagate to child hosts, which dispose their own matching objects (e.g. relayed guests).
		if (typeof match !== "function") {
			for (const connection of this.connections) {
				if (connection.role === "downstream" && connection.peer.kind === "host") {
					connection.send({ t: "invalidate", pattern: match });
				}
			}
		}
		const matching = [...this.objects.values()].filter(
			(object) => !this.isSelf(object.principal) && matches(object.principal),
		);
		await disposeHoldersFirst(matching, reason, "invalidatePrincipal: disposal failed");
	}

	// ─── links ───

	accept(link: Link, options: AcceptOptions): void {
		const kind = options.kind ?? "client";
		if (kind === "host" && options.name === undefined) throw new TypeError("accepting a host link needs its name");
		this.#addConnection(link, {
			...options,
			role: "downstream",
			principal: options.principal,
			peer: { kind, name: kind === "host" ? options.name : undefined },
			// Holds over a client link carry its id as their origin (also when relayed), so hosts can tell clients apart.
			...(kind === "client" ? { originId: `${this.#incarnation}:${++this.#originSeq}` } : {}),
		});
	}

	connect(link: Link, options: ConnectOptions): void {
		if (!("principal" in options))
			throw new TypeError("connect needs `principal`: what the parent's own requests act as");
		if (this.upstream?.open) this.upstream.link.close("replaced");
		const connection = this.#addConnection(link, {
			...options,
			role: "upstream",
			principal: options.principal,
			peer: { kind: "host", name: undefined },
		});
		this.upstream = connection;
		// Bindings that lost their link re-hold over the new one (`again`: they keep their values meanwhile).
		for (const binding of this.bindings.values())
			if (binding.hold === undefined && !binding.ended) connection.hold(binding, binding.applied);
	}

	#addConnection(link: Link, config: ConstructorParameters<typeof Connection>[2]): Connection {
		const connection = new Connection(this, link, config);
		// A link that was already closed closed the connection in its constructor: keeping it would route to it forever.
		if (connection.open) this.connections.add(connection);
		return connection;
	}

	route(prefix: string, route: Route): void {
		if (typeof route.principal !== "function")
			throw new TypeError(`route ${prefix} needs \`principal\`: what the routed hosts act as when they call back`);
		this.#routes.set(prefix, route);
	}

	/**
	 * A child host announced its code version. In step: usable. Behind: fenced (nothing is routed to it) and reconciled
	 * by a reload of its modules to this host's code version, never by renumbering what it runs. Ahead: impossible,
	 * refused.
	 */
	peerHello(connection: Connection, codeVersion: number): void {
		if (codeVersion > this.current.id) {
			this.report(
				new ChordError(
					"invalid",
					`${connection.name} runs code version ${codeVersion}, ahead of ${this.current.id}`,
				),
			);
			connection.link.close("code version ahead of parent");
			return;
		}
		if (this.reloading) {
			// Not a participant of the running reload (participants are fixed when it starts): in step now, it would miss
			// the commit. Decided when the reload ends. A child already behind is fenced now, so the calls its roots make
			// meanwhile are admitted in this host's code version (never relabeled) instead of being `superseded`.
			connection.peerCodeVersion = codeVersion;
			if (codeVersion < this.current.id) connection.fencedCodeVersions.add(codeVersion);
			this.#deferredHellos.set(connection, codeVersion);
			return;
		}
		if (codeVersion === this.current.id) {
			connection.markSynced(codeVersion);
			this.announceRetired(connection);
			return;
		}
		connection.peerCodeVersion = codeVersion;
		connection.fencedCodeVersions.add(codeVersion);
		reconcileChild(this, connection).catch((error: unknown) => {
			this.report(error);
			connection.link.close("reconciliation failed");
		});
	}

	/** The host's reload slot was freed: children that said hello meanwhile are synced or reconciled now. */
	reloadEnded(): void {
		this.reloading = false;
		const deferred = [...this.#deferredHellos];
		this.#deferredHellos.clear();
		for (const [connection, codeVersion] of deferred) if (connection.open) this.peerHello(connection, codeVersion);
		for (const resolve of this.#reloadWaiters.splice(0)) resolve();
		this.maybeRetire();
	}

	/** Resolves once no reload runs on this host. */
	whenReloadEnded(): Promise<void> {
		if (!this.reloading) return Promise.resolve();
		return new Promise((resolve) => this.#reloadWaiters.push(resolve));
	}

	connectionClosed(connection: Connection): void {
		this.connections.delete(connection);
		this.#deferredHellos.delete(connection);
		// Foreign roots that came over this link will never announce their end over it.
		for (const [rootId, links] of [...this.#foreign])
			if (links.has(connection)) this.foreignRootEnded(rootId, connection);
		for (const links of this.#rootLinks.values()) links.delete(connection);
		if (this.upstream === connection) {
			this.upstream = undefined;
			this.#childReloads.parentLost();
		}
	}

	/** The last reference to `binding` was released: it lingers if its type does (`HostOptions.linger`), else closes. */
	bindingIdle(binding: RemoteBinding): void {
		const ms = Object.hasOwn(this.#lingerTypes, binding.contract.name)
			? this.#lingerTypes[binding.contract.name]!
			: 0;
		// A binding that never had a shape has nothing worth keeping.
		if (ms <= 0 || binding.ended || !binding.applied || this.#lingerCap <= 0) {
			binding.close();
			return;
		}
		binding.lingerTimer = setTimeout(() => binding.close(), ms);
		(binding.lingerTimer as { unref?: () => void }).unref?.();
		this.#lingering.set(binding.key, binding);
		for (const oldest of this.#lingering.values()) {
			if (this.#lingering.size <= this.#lingerCap) break;
			oldest.close();
		}
	}

	forgetBinding(binding: RemoteBinding): void {
		if (this.bindings.get(binding.key) === binding) this.bindings.delete(binding.key);
		if (this.#lingering.get(binding.key) === binding) this.#lingering.delete(binding.key);
	}

	/** A downstream host connection by its configured name (never by what a peer announced). */
	#childNamed(name: string): Connection | undefined {
		return [...this.connections].find(
			(connection) =>
				connection.open &&
				connection.role === "downstream" &&
				connection.peer.kind === "host" &&
				connection.peer.name === name,
		);
	}

	/**
	 * A reference to an object on host `at`: a view onto the binding for its key, created (and held) if there is none.
	 * `input` is normalized with `type` (the hold carries it so).
	 */
	#acquireRemote(
		type: AnyContract,
		at: string,
		input: unknown,
		options: GetOptions | undefined,
		owner: RefOwner,
	): RefCore {
		const principal =
			options?.principal === undefined || this.isSelf(options.principal) ? undefined : options.principal;
		const key = this.#remoteKey(type, input, principal ?? this.principal);
		let binding = this.bindings.get(key);
		const fresh = binding === undefined || binding.ended;
		if (binding === undefined || binding.ended) {
			binding = new RemoteBinding(this, { key, contract: type, at, input, principal });
			this.bindings.set(key, binding);
		}
		const ref = new RemoteRef(binding, owner, options?.state !== false);
		this.#lingering.delete(key);
		binding.addView(ref);
		if (fresh) this.#hold(binding);
		return ref;
	}

	/** Holds `binding` over the link to its host: the parent's, a child's, or one a route resolves. */
	#hold(binding: RemoteBinding): void {
		const bindWhenSynced = (connection: Promise<Connection>): void => {
			connection.then(
				(target) => {
					if (!binding.ended && binding.hold === undefined) target.hold(binding, false);
				},
				(error: unknown) => binding.gone(error),
			);
		};
		const direct = this.#childNamed(binding.at);
		if (this.upstream !== undefined) this.upstream.hold(binding, false);
		else if (direct !== undefined) bindWhenSynced(direct.whenSynced().then(() => direct));
		else {
			const route = this.#routeFor(binding.at);
			if (route === undefined) binding.gone(new ChordError("unavailable", `no route to ${binding.at}`));
			else bindWhenSynced(this.#resolve(route, binding.at, binding.principal ?? this.principal));
		}
	}

	#routeFor(hostName: string): Route | undefined {
		let best: [string, Route] | undefined;
		for (const entry of this.#routes) {
			if (hostName.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry;
		}
		return best?.[1];
	}

	/** Authorize, resolve (maybe spawn), authorize again; returns the synced connection to the host. */
	async #resolve(
		route: Route,
		hostName: string,
		principal: unknown,
		still: () => boolean = () => true,
	): Promise<Connection> {
		const refuse = (): ChordError => new ChordError("forbidden", `${hostName} refused for this principal`);
		const revoked = (): ChordError => new ChordError("gone", "principal invalidated while resolving");
		if (!(await route.authorize(principal, hostName))) throw refuse();
		if (!still()) throw revoked();
		const link = await route.resolve(hostName);
		if (!still()) throw revoked();
		if (!(await route.authorize(principal, hostName))) throw refuse();
		if (!still()) throw revoked();
		let connection = [...this.connections].find((candidate) => candidate.link === link);
		connection ??= this.#addConnection(link, {
			role: "downstream",
			principal: route.principal(hostName),
			peer: { kind: "host", name: hostName },
		});
		await connection.whenSynced();
		if (!still()) throw revoked();
		return connection;
	}

	/**
	 * Relays a reference from `relay.origin` to the host it names. Relaying needs a route: it is where authorization
	 * lives. The origin's authorization generation is re-checked after every await and right before forwarding, so a
	 * revocation during resolution wins.
	 */
	async relay(relay: RelayRef): Promise<void> {
		const at = relay.frame.at;
		// The hold names its target; its contract token says where the type lives. They must agree.
		const placement = contractFromDescription(relay.frame.token).description.host;
		if (placement === undefined || resolveHost(relay.frame.token.name, placement, relay.frame.input) !== at)
			throw invalid("placement", `${relay.frame.token.name} with this input does not live on ${at}`);
		const route = this.#routeFor(at);
		if (route === undefined) {
			throw this.#childNamed(at) === undefined
				? new ChordError("unavailable", `no route to ${at}`)
				: new ChordError("forbidden", `no route authorizes ${at}`);
		}
		const down = await this.#resolve(route, at, relay.principal, () => relay.current);
		if (!relay.current) return;
		relay.open(down);
	}

	reload(plugins: readonly PluginRef[], options: ReloadOptions = {}): Promise<ReloadReport> {
		// Client-local facet code versions never cross the parent link; only child hosts require cluster coordination.
		if (this.kind !== "client" && this.upstream !== undefined) {
			return Promise.reject(
				new ChordError("unavailable", "reloads are coordinated by the server", { reason: "not_coordinator" }),
			);
		}
		const children = [...this.connections].some(
			(connection) => connection.role === "downstream" && connection.peer.kind === "host",
		);
		return children || options.remote !== undefined || options.remoteRemove !== undefined
			? runClusterReload(this, plugins, options)
			: runReload(this, plugins, options);
	}

	onReloadFrame(connection: Connection, frame: Extract<Frame, { t: "prepare" | "commit" | "abort" }>): void {
		this.#childReloads.handle(connection, frame);
	}

	rememberRemoteModules(
		remote: Readonly<Record<string, readonly string[]>> | undefined,
		remove: Readonly<Record<string, readonly string[]>> | undefined,
	): void {
		for (const prefix of new Set([...Object.keys(remote ?? {}), ...Object.keys(remove ?? {})])) {
			const modules = remote?.[prefix] ?? [];
			const removed = remove?.[prefix] ?? [];
			this.remoteModules[prefix] = [...new Set([...(this.remoteModules[prefix] ?? []), ...modules])].filter(
				(module) => !removed.includes(module),
			);
			this.remoteRemoved[prefix] = [...new Set([...(this.remoteRemoved[prefix] ?? []), ...removed])].filter(
				(module) => !modules.includes(module),
			);
		}
	}

	/** The code version id the next reload would commit. */
	peekNextCodeVersion(): number {
		return this.#codeVersionSeq + 1;
	}

	/**
	 * Disposes every object, holders before what they reference (a resource's `close` may still use the objects its object
	 * references, local or remote), then closes the links.
	 */
	async close(): Promise<void> {
		for (const binding of [...this.#lingering.values()]) binding.close();
		this.hostObjects.clear();
		for (const name of [...this.#facetRuns.keys()]) this.facetRunChanged(name, undefined);
		const reason = new ChordError("gone", `host ${this.name} closed`);
		try {
			await disposeHoldersFirst([...this.objects.values()], reason, "host close: disposal failed");
		} finally {
			for (const connection of [...this.connections]) connection.link.close("host closed");
		}
	}
}

/**
 * Force-disposes `objects` in waves: an object goes once no object of the set that references it is left, so holders are
 * disposed (and their resources closed) while what they reference is still live. In-host references are acyclic. Errors of
 * every disposal are collected.
 */
async function disposeHoldersFirst(objects: readonly ObjectImpl[], reason: unknown, message: string): Promise<void> {
	const remaining = new Set(objects);
	const held = (object: ObjectImpl): Set<ObjectImpl> => {
		const result = new Set<ObjectImpl>();
		for (const decls of object.allDecls()) {
			for (const ref of decls.refs.values()) if (ref.object !== undefined) result.add(ref.object);
		}
		return result;
	};
	const refs = new Map(objects.map((object) => [object, held(object)] as const));
	const errors: unknown[] = [];
	while (remaining.size > 0) {
		const heldByRemaining = new Set<ObjectImpl>();
		for (const object of remaining) for (const target of refs.get(object) ?? []) heldByRemaining.add(target);
		let wave = [...remaining].filter((object) => !heldByRemaining.has(object));
		// A cycle cannot happen in-host; dispose the rest together rather than loop.
		if (wave.length === 0) wave = [...remaining];
		for (const object of wave) remaining.delete(object);
		const results = await Promise.allSettled(wave.map((object) => object.dispose(true, reason)));
		for (const result of results) if (result.status === "rejected") errors.push(result.reason);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}

function sameTable(a: RegistryTable<unknown>, b: RegistryTable<unknown>): boolean {
	if (a.size !== b.size) return false;
	const keys = [...a.keys()];
	return [...b].every(([key, value], index) => keys[index] === key && a.get(key) === value);
}

const matchesPattern = (pattern: Readonly<Record<string, unknown>>, principal: unknown): boolean =>
	principal !== null &&
	typeof principal === "object" &&
	Object.entries(pattern).every(([key, value]) => deepEqual((principal as Record<string, unknown>)[key], value));

const unknownType = (type: string, host: string): ChordError =>
	new ChordError("unavailable", `${type} is not served by ${host}`, { reason: "unknown_type" });

/** True if `from` references `to`, directly or transitively, through object-owned references on this host. */
function reaches(from: ObjectImpl, to: ObjectImpl): boolean {
	const seen = new Set<ObjectImpl>();
	const stack = [from];
	while (stack.length > 0) {
		const object = stack.pop()!;
		if (object === to) return true;
		if (seen.has(object)) continue;
		seen.add(object);
		// Remote references have no object here: cycles across hosts are avoided by convention.
		for (const decls of object.allDecls()) {
			for (const ref of decls.refs.values()) if (ref.object !== undefined) stack.push(ref.object);
		}
	}
	return false;
}
