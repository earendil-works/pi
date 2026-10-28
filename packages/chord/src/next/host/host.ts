// Hosts (§3): `createHost`, loading facets and the start barrier, links to children, the parent (connected again after
// a drop) and routes, the origins it relays holds for, getting and holding references as a principal, the heartbeat
// of every link, revocation (§4), presence (§19) and keep-alive counts, closing; one batch per host, the backoff map
// and the endings new instances wait for.

import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal, withoutAbortSignal } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Watchable } from "../../watch.ts";
import type { Address, Contract, HostKind, ParamsOf } from "../contracts/index.ts";
import { contractData, type Params } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal, type PrincipalKeyFunction } from "../data/index.ts";
import {
	asChordError,
	bindProvider,
	canonicalJson,
	checkParams,
	identityKey,
	invalid,
	principalKey,
} from "../data/internal.ts";
import { binaryCodec, type Codec, type Compression, type Link, type PartLimits } from "../link/index.ts";
import { linkLimits } from "../link/internal.ts";
import {
	type HoldRequest,
	HostLink,
	type LinkRole,
	Path,
	type ProviderSide,
	RemoteObject,
} from "../remote/internal.ts";
import { Batch, type BatchError } from "../state/internal.ts";
import type { ChordStore, Store } from "../store/store.ts";
import { Activity, type ActivityCounts } from "./activity.ts";
import { notLive } from "./attempt.ts";
import { Backoff } from "./backoff.ts";
import { type Caller, withLinkedAbortSignal } from "./ctx.ts";
import { type Facet, type ServedEntry, setUp } from "./facet.ts";
import type { CloseFailed } from "./native.ts";
import { ChordObject, type Holder, type LocalContract, type RemoteContract, type Served } from "./object.ts";
import { type Placed, Placement } from "./placement.ts";
import { type Presence, References } from "./presence.ts";
import { Binding, type CheckedParams, type Held, type Reference, type Target } from "./reference.ts";
import { RevocationKeys, type RevokedBy } from "./revocation.ts";
import { Route, type RouteOptions } from "./route.ts";
import { uuidv7 } from "./uuid.ts";

/** What `createHost` takes; `R` is the app's revocation type (JSON). */
export type HostOptions<P extends Principal = Principal, R extends JsonValue = JsonValue> = {
	/** This host's address (`Session({ id })`): it serves only objects placed there. Without one, a client. */
	readonly address?: Address;
	/** Who this host acts as for its own requests; a host without one (a client) has none. */
	readonly principal?: P;
	/** The key of a principal in identities; L1's canonical JSON by default. The same function on every host. */
	readonly principalKey?: PrincipalKeyFunction<P>;
	/** The telemetry adapter; NOOP by default. */
	readonly telemetry?: TelemetryContext;
	/** Everything that fails in the background; every app handles it. */
	readonly onError: (error: HostError) => void;
	/** How long a native's close, and an ending object's running calls, are waited for; 30 s by default. */
	readonly closeTimeout?: number;
	/** How long an activation attempt, and a `get`, may take until the object is live; 60 s by default. */
	readonly readyTimeout?: number;
	/**
	 * The heartbeat of every link: a link silent for `ping` ms (15 s by default) sends a `ping`; one silent for `close`
	 * ms (30 s by default), its handshake included, is closed.
	 */
	readonly heartbeat?: { readonly ping?: number; readonly close?: number };
	/**
	 * What revokes a principal (§4): `host.revoke(r)` ends the objects and closes the child links of every principal
	 * `p` whose `revokedBy(p)` holds `r` (compared as canonical JSON). The same function on every host.
	 */
	readonly revokedBy?: RevokedBy<P, R>;
	/**
	 * A synchronous compressor (`nodeCompression` for Node): JSON parts above 16 KiB this host originates are deflated
	 * once, and deflated parts it owns inflated in place. Without one (a browser), nothing is compressed and deflated
	 * parts are inflated asynchronously, later messages of their link waiting in order.
	 */
	readonly compression?: Compression;
	/**
	 * The store persisted documents and tables live in (`openStore`); the app owns it and closes it after the host.
	 * One open host per store. A `storage_failed` of the store is reported once and closes the host.
	 */
	readonly store?: Store;
};

/** Where a reported part sits on its object: a routine (`on`, `onLive`) or a native, by kind, from 1 in declaration order. */
export type Position = { readonly kind: "on" | "onLive" | "native"; readonly position: number };

/**
 * What `onError` gets, by kind. `object` is the object's type, with its params key when it has params; `failure` is a
 * `FailureCause`, `error` the plain error.
 */
export type HostError =
	| BatchError
	| { readonly kind: "activation_failed"; readonly object: string; readonly failure: FailureCause }
	/** A live object failed at runtime (a `migrate` failing on access, a stored version newer than the code). */
	| { readonly kind: "object_failed"; readonly object: string; readonly failure: FailureCause }
	/** The host's store stopped after a backend error: the host closes itself (once). */
	| { readonly kind: "storage_failed"; readonly error: unknown }
	| { readonly kind: "close_failed"; readonly object: string; readonly native: Position; readonly error: unknown }
	| { readonly kind: "close_timeout"; readonly object: string; readonly native: Position }
	| { readonly kind: "drain_timeout"; readonly object: string }
	| { readonly kind: "protocol_error"; readonly error: unknown }
	| { readonly kind: "resolve_failed"; readonly address: string; readonly error: unknown }
	/**
	 * A derive's compute threw (its owner's, once per failure episode: the first failure after a value or after its
	 * creation; a value ends the episode); `member` when it is an exposed state member.
	 */
	| { readonly kind: "derive_failed"; readonly object: string; readonly member?: string; readonly error: unknown }
	/** A routine's call threw, or its source failed for good; `routine` is its kind and position. */
	| { readonly kind: "routine_failed"; readonly object: string; readonly routine: Position; readonly error: unknown }
	/** A job's `run` threw (not after an abort): its outcome is `failed { threw }`. */
	| {
			readonly kind: "job_failed";
			readonly object: string;
			readonly job: string;
			readonly id: string;
			readonly error: unknown;
	  }
	/** A job's `finish` threw: retried with backoff, blocked after five failures in a row. */
	| {
			readonly kind: "job_finish_failed";
			readonly object: string;
			readonly job: string;
			readonly id: string;
			readonly error: unknown;
	  }
	/** A persisted run was cut off five times in a row by crashes (D6): it ends `failed { restart_limit }`, `finish` runs. */
	| {
			readonly kind: "job_interrupted";
			readonly object: string;
			readonly job: string;
			readonly id: string;
			readonly restarts: number;
	  }
	/** A blocked run was dropped without `finish`: aborted, or its object ended. */
	| { readonly kind: "job_dropped"; readonly object: string; readonly job: string; readonly id: string };

/**
 * What `accept` and `connect` take: the principal of the host at the other end, as this host stamps it; `trusted` skips
 * the message check on the link (IPC to the host's own processes; never grants the principal fields); the codec both
 * ends of the link use (`binaryCodec` by default); and the limits per part of what arrives on it (Q2: none on a
 * trusted link, 16 MiB on the wire and 64 MiB decoded otherwise, unless set).
 */
export type LinkOptions<P extends Principal = Principal> = {
	readonly principal: P;
	readonly trusted?: boolean;
	readonly codec?: Codec;
	readonly limits?: PartLimits;
};

/** What `host.get` and `host.hold` take besides the type, the params and the context. */
export type GetOptions = {
	/**
	 * A getter's deadline for its whole wait, and how long a call made while the reference is loading waits (the park
	 * deadline); the host's `readyTimeout` by default.
	 */
	readonly readyTimeout?: number;
};

/**
 * A host whatever its principal type, as Chord's own parts use it: `ChordHost<P>` is invariant in `P` (`load` takes
 * facets typed for exactly `P`).
 */
export type AnyHost = Omit<ChordHost, "load" | "accept" | "connect" | "route" | "references">;

/** A host. `P` is the app's principal type, `R` its revocation type. */
export interface Host<P extends Principal = Principal, R extends JsonValue = JsonValue> {
	/**
	 * Runs every facet's setup, then activates every served type with empty params and resolves when each has had its
	 * first outcome, live or failed (the start barrier; failures go to `onError`). A setup that throws rejects it and
	 * closes the host. Runs once.
	 */
	load(facets: readonly { readonly name: string; readonly facet: Facet<P> }[], context: Context): Promise<void>;
	/**
	 * A reference once its object is live; waits for `load` first. It acts as the host's principal and goes where its
	 * type's placement puts it: here, over a route, or over the parent link (`Placement`). A broken failure rejects at
	 * once; through transient ones it waits until its deadline, then rejects with the last failure's error.
	 */
	get<C extends Contract>(Type: C, params: ParamsOf<C>, context: Context, options?: GetOptions): Promise<Reference<C>>;
	/**
	 * A reference at once, following its object until released: loading, live, failed (retried as its object is) and
	 * loading again while its link is down; it never rejects. Throws at once for invalid params and a local type not
	 * served here; before `load` resolved these are decided once it did, failing the reference broken. Its `variant` is `undefined` until its first binding.
	 */
	hold<C extends Contract>(Type: C, params: ParamsOf<C>, context: Context, options?: GetOptions): Held<C>;
	/**
	 * A link from a child: this host serves its remote types over it, every hold and call arriving on it acting as
	 * `principal`. `context` is the parent of the work arriving on it (its cancellation is dropped).
	 */
	accept(link: Link, options: LinkOptions<P>, context: Context): void;
	/**
	 * This host's parent link: remote types not served here and not routed are held over it, every such reference held
	 * again on a new one; holds arriving on it may name whom they act for. Throws while the previous one is open; once
	 * it closed (a drop), `connect` takes the next. `principal` is who the parent is.
	 */
	connect(link: Link, options: LinkOptions<P>, context: Context): void;
	/**
	 * How this host reaches hosts of `Kind` (called before `load`, once per kind): `authorize` admits every hold routed
	 * over it, `resolve` makes the link of an address. Holds for an address wait while it resolves and again after its
	 * link drops (a backoff per address, 1 s doubling to 60 s), while they exist. `context` is the parent of the route's
	 * work (its `resolve`s, the holds and calls on its links), aborted for it when this host closes.
	 */
	route<N extends string, Q extends Params>(
		Kind: HostKind<N, Q>,
		options: RouteOptions<P, HostKind<N, Q>>,
		context: Context,
	): void;
	/**
	 * Revokes `revocation` (§4, R10, R11), synchronously: every remote object whose principal it revokes (`revokedBy`)
	 * ends at once, whatever references remain (holders get `forbidden`, running calls are aborted, an activation is
	 * abandoned); every child link whose principal it revokes closes (never the parent, never this host's own
	 * principal); and every route link is sent `revoke`, which the host there applies with its own `revokedBy`. Nothing
	 * is replayed to links made later.
	 */
	revoke(revocation: R, context: Context): void;
	/**
	 * The references to objects of `Type` on this host (§19), one entry per reference: the object's params, the
	 * principal it acts as (remote types) and its origin, the incarnation of the host it was made for (two tabs are two
	 * origins). Changes in the batch where a reference binds or ends; a link drop is a departure.
	 */
	references<C extends Contract>(Type: C): Watchable<readonly Presence<C, P>[]>;
	/**
	 * The work keeping this host busy, for the app's supervisor: holds arriving over links and served here, method
	 * calls running, running jobs and lingering objects; published at most once per microtask turn with changes.
	 */
	readonly activity: Watchable<ActivityCounts>;
	/**
	 * Closes its links, then ends every object at once, then drains and closes them one by one, the last to go live
	 * first (reason `close`). Rejects with an `AggregateError` of the closes that threw.
	 */
	close(context: Context): Promise<void>;
}

/** Creates a host. */
export function createHost<P extends Principal = Principal, R extends JsonValue = JsonValue>(
	options: HostOptions<P, R>,
): Host<P, R> {
	return new ChordHost<P, R>(options);
}

/** No activation chain (Q5). */
const NO_CHAIN: readonly string[] = [];

/** The params of a type with empty params, as checked: nothing, and the empty key. */
const EMPTY_PARAMS: CheckedParams = { params: {}, key: "" };

/** An npm package name, scoped or not. */
const PLUGIN_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/** The host: its served types, its objects by identity, its batch, backoff and endings. */
export class ChordHost<P extends Principal = Principal, R extends JsonValue = JsonValue> implements Host<P, R> {
	readonly batch: Batch;
	readonly timeouts: { readonly close: number; readonly ready: number };
	readonly backoff = new Backoff((identity) => this.#due(identity));
	readonly address: Address | undefined;
	readonly principal: P | undefined;
	/** This run of the host, sent in every handshake (R20). */
	readonly incarnation = uuidv7();
	readonly compression: Compression | undefined;
	/** The host's store, if it has one. */
	readonly store: ChordStore | undefined;
	readonly #activity: Activity;
	readonly #principalKey: PrincipalKeyFunction<P> | undefined;
	readonly #revocationKeys: RevocationKeys;
	/** The presence list of each type someone asked about (`references`), by type name. */
	readonly #references = new Map<string, References>();
	readonly #onError: (error: HostError) => void;
	readonly #types = new Map<string, Served>();
	/** By identity, in the order they went live (the others where they were created). */
	readonly #objects = new Map<string, ChordObject>();
	/** Teardowns still running, by identity: the next instance of an identity waits for its previous ones. */
	readonly #endings = new Map<string, Promise<void>>();
	readonly #loaded = Promise.withResolvers<void>();
	/** Every open link: children, routes and the parent. */
	readonly #links = new Set<HostLink>();
	/** Where holds go that are not served here and not routed: the parent link, across reconnects. */
	readonly #parent = new Path(() => {});
	/**
	 * Remote references failed for a part past a link's limits: on no link's path (no reconnect holds them, no route
	 * resolves for them) until `ref.retry()` places them anew; ended at `close` like the others.
	 */
	readonly unplaced = new Path(() => {});
	readonly #routes = new Map<string, Route>();
	readonly #placement: Placement;
	/** The downstream origins this host relays holds for, by their number on upstream links (never reused). */
	readonly relays = new Map<number, ProviderSide>();
	#nextOrigin = 1;
	/** Aborted when the host closes: the context of every route's `resolve`. */
	readonly #routing = new AbortController();
	readonly #heartbeat: { readonly ping: number; readonly close: number };
	/** The one heartbeat timer, running while the host has a link. */
	#ticking: ReturnType<typeof setInterval> | undefined;
	#state: "new" | "loading" | "loaded" | "closed" = "new";
	/** The one closing, which every `close` returns. */
	#closing: Promise<void> | undefined;

	constructor(options: HostOptions<P>) {
		this.address = options.address;
		this.principal = options.principal;
		this.#principalKey = options.principalKey;
		this.#onError = options.onError;
		this.batch = new Batch((error) => this.report(error), options.telemetry?.metrics);
		this.compression = options.compression;
		this.#activity = new Activity(this.batch);
		// `revokedBy` is called with this host's principals only, the `P`s its links stamp.
		this.#revocationKeys = new RevocationKeys(options.revokedBy as RevokedBy<Principal, JsonValue> | undefined);
		this.timeouts = { close: options.closeTimeout ?? 30_000, ready: options.readyTimeout ?? 60_000 };
		this.#heartbeat = { ping: options.heartbeat?.ping ?? 15_000, close: options.heartbeat?.close ?? 30_000 };
		this.#placement = new Placement(this.address, this.#types, this.#routes, this.#parent);
		// Chord's own: `openStore` made it.
		this.store = options.store as ChordStore | undefined;
		this.store?.attach({ failed: (error) => this.#storageFailed(error), batch: this.batch });
	}

	async load(facets: readonly { readonly name: string; readonly facet: Facet<P> }[], context: Context): Promise<void> {
		this.batch.assertOutside("load");
		this.#assertOpen();
		if (this.#state !== "new") throw new Error("load runs once per host");
		this.#state = "loading";
		try {
			this.#setUp(facets);
		} catch (error) {
			// The host closes as `close` would: its links too. Nothing was activated, so no close can fail.
			this.#closing ??= this.#close();
			await this.#closing.catch(() => {});
			throw error;
		}
		const objects = [...this.#types.values()]
			.filter((served) => served.kind === "local" && served.hostLifetime)
			.map((served) => this.#object(served, EMPTY_PARAMS, undefined, context));
		await Promise.allSettled(objects.map(({ settled }) => settled));
		if (this.#state === "loading") this.#state = "loaded";
		this.#loaded.resolve();
	}

	async get<C extends Contract>(
		Type: C,
		params: ParamsOf<C>,
		context: Context,
		options: GetOptions = {},
	): Promise<Reference<C>> {
		const binding = await this.acquire(Type, params, this.#own(), context, options);
		// The binding was built from `Type`'s members.
		return binding.reference as Reference<C>;
	}

	hold<C extends Contract>(Type: C, params: ParamsOf<C>, context: Context, options: GetOptions = {}): Held<C> {
		this.batch.assertOutside("hold");
		// The binding was built from `Type`'s members; it may be unbound, so `variant` may be undefined.
		return this.#hold(Type, params, this.#own(), context, options).reference as Held<C>;
	}

	accept(link: Link, options: LinkOptions<P>, context: Context): void {
		this.#assertOpen();
		this.#link(link, "child", options, context);
	}

	connect(link: Link, options: LinkOptions<P>, context: Context): void {
		this.#assertOpen();
		if (this.#parent.link !== undefined) throw new Error("connect: this host has an open parent link");
		const parent = this.#link(link, "parent", options, context);
		if (parent.open) this.#parent.connected(parent);
	}

	route<N extends string, Q extends Params>(
		Kind: HostKind<N, Q>,
		options: RouteOptions<P, HostKind<N, Q>>,
		context: Context,
	): void {
		this.#assertOpen();
		if (this.#state !== "new") throw new Error("route: routes are declared before load");
		if (this.#routes.has(Kind.kind)) throw new Error(`route: ${Kind.kind} is routed already`);
		// The parent of the route's work: its `resolve`s and the holds and calls on its links, aborted when it closes.
		const routing = withAbortSignal(this.#routing.signal, context);
		// A route calls `authorize` with the principals of holds on this host, `P`s, and addresses of `Kind`.
		const route = new Route(
			Kind as unknown as HostKind,
			options as unknown as RouteOptions<Principal, HostKind>,
			this,
			routing,
		);
		this.#routes.set(Kind.kind, route);
	}

	revoke(revocation: R, context: Context): void {
		const key = canonicalJson(revocation, context);
		const revoked = (principal: Principal): boolean =>
			!this.#isOwn(principal, context) && this.#revocationKeys.revokes(principal, key, context);
		const error = (label: string): ChordError =>
			new ChordError({ code: "forbidden", reason: "revoked", message: `${label}: revoked` });
		for (const object of [...this.#objects.values()]) {
			if (object.principal !== undefined && revoked(object.principal)) object.end(error(object.label));
		}
		// Holds admitted before this revoke but still waiting for `load` would take revoked objects afterwards.
		const waiting = error("a hold waiting for load");
		for (const link of this.#links) link.revokeWaiting(revoked, waiting);
		// Down the route links before the child links close: a worker ends the principal's objects with the revocation's
		// error before the closed origins release their holds.
		for (const link of this.#links) if (link.role === "route") link.send({ kind: "revoke", revocation });
		for (const link of [...this.#links]) if (link.role === "child" && revoked(link.principal)) link.close();
	}

	get activity(): Watchable<ActivityCounts> {
		// Its value is an `ActivityCounts`.
		return this.#activity as unknown as Watchable<ActivityCounts>;
	}

	references<C extends Contract>(Type: C): Watchable<readonly Presence<C, P>[]> {
		let references = this.#references.get(Type.name);
		if (references === undefined) {
			references = new References(this.batch);
			for (const object of this.#objects.values()) {
				if (object.served.contract.name !== Type.name) continue;
				for (const holder of object.holders) references.record(object, holder);
			}
			this.#references.set(Type.name, references);
		}
		// Entries of `Type`'s objects, acting as `P`s.
		return references as unknown as Watchable<readonly Presence<C, P>[]>;
	}

	async close(_context: Context): Promise<void> {
		this.batch.assertOutside("close");
		this.#closing ??= this.#close();
		return this.#closing;
	}

	/**
	 * What a hold arriving before `load` resolved waits for; `undefined` once it resolved (or the host closed), so a
	 * later hold takes its reference at once, in the turn it arrived (R18's handover: a new hold before the old's release).
	 */
	get pendingLoad(): Promise<void> | undefined {
		return this.#state === "new" || this.#state === "loading" ? this.#loaded.promise : undefined;
	}

	/** Whether the host closes: its objects end through `close`, not through its links. */
	get closing(): boolean {
		return this.#state === "closed";
	}

	/**
	 * A reference to `Type` made by `caller` (its principal, its origin's incarnation), once it is live (`host.get`,
	 * `ctx.get`): a hold, waited for up to the getter's one deadline, across reconnects; a broken failure rejects at
	 * once, the deadline with the last failure's error. A getter that gives up releases its reference.
	 */
	async acquire(
		Type: Contract,
		params: unknown,
		caller: Caller,
		context: Context,
		options: GetOptions,
	): Promise<Binding> {
		this.batch.assertOutside("get");
		const binding = this.#hold(Type, params, caller, context, options);
		const timeout = options.readyTimeout ?? this.timeouts.ready;
		const expired = new AbortController();
		const waiting = withLinkedAbortSignal(expired.signal, context);
		const deadline = setTimeout(() => expired.abort(binding.lastFailure ?? notLive(binding.label, timeout)), timeout);
		try {
			await binding.live(waiting.context);
			return binding;
		} catch (error) {
			binding.release();
			throw error;
		} finally {
			clearTimeout(deadline);
			waiting.release();
		}
	}

	/** Adds `delta` to the keep-alive count of `kind` (`host.activity`), where the work happens. */
	count(kind: keyof ActivityCounts, delta: number): void {
		this.#activity.count(kind, delta);
	}

	/** `holder` references `object`: listed in its type's presence, if someone asked for it. */
	referenced(object: ChordObject, holder: Holder, context: Context): void {
		this.#references.get(object.served.contract.name)?.add(object, holder, context);
	}

	/** `holders` of `object` ended: gone from its type's presence. */
	unreferenced(object: ChordObject, holders: Iterable<Holder>, context: Context): void {
		this.#references.get(object.served.contract.name)?.remove(holders, context);
	}

	/** Reports a background failure to `onError`; a throwing `onError` has nowhere left to report to. */
	report(error: HostError): void {
		try {
			this.#onError(error);
		} catch {
			// Nothing to do: teardowns and attempts go on.
		}
	}

	/**
	 * An unbound reference to an object of `Type` made by `caller`, declared by `dependent` (`undefined` for
	 * `host.get`, `host.hold` and `ctx.get`). Throws where it cannot go (`#assertRoute`).
	 */
	reference(Type: Contract, dependent: ChordObject | undefined, caller: Caller, options: GetOptions): Binding {
		this.#assertOpen();
		this.#assertRoute(Type);
		return this.#binding(Type, dependent, caller, options);
	}

	/**
	 * Binds `binding` to the object for (Type, params) as its principal where its placement puts it (`Placement`): the
	 * object here, created with its first attempt if there is none, or a remote object held over its path. Throws as
	 * `Placement.reference` does.
	 */
	bind(binding: Binding, Type: Contract, params: CheckedParams, context: Context): Target {
		const { principal } = binding.caller;
		const placed = this.#placement.reference(Type, params.params, principal, context);
		let target: Target;
		if (placed.kind === "path") {
			const { caller, dependent } = binding;
			const remote = new RemoteObject(this, Type, params, placed.address, caller, placed.path, dependent);
			placed.path.attach(remote);
			target = remote;
		} else {
			// Placed here: its type is served here.
			const served = this.#types.get(Type.name)!;
			target = this.#object(served, params, principal, context, NO_CHAIN, binding.dependent);
		}
		binding.bind(target);
		return target;
	}

	/** Where a hold arriving on `link` goes (`Placement.hold`); `released` once the host closed. */
	place(request: HoldRequest, link: HostLink, caller: Caller, context: Context): Placed {
		this.#assertOpen();
		return this.#placement.hold(request, link, caller.principal, context);
	}

	/**
	 * The object a hold placed here binds to, acting as `principal`: a remote type served here (otherwise
	 * `unavailable`) with the hold's version and fingerprint (`contract_mismatch`), valid params, and placed here, its
	 * placement computed from the params (`invalid/placement`); not an activation the hold's chain waits for
	 * (`invalid/cycle`, Q5). A new object keeps the hold's chain.
	 */
	serving(request: HoldRequest, params: unknown, principal: Principal, context: Context): ChordObject {
		const { type, version, fingerprint, chain = NO_CHAIN } = request;
		const served = this.#types.get(type);
		if (served?.kind !== "remote") {
			throw new ChordError({ code: "unavailable", message: `${type} is not served here` });
		}
		this.#assertMatch(served, version, fingerprint);
		const checked = checkParams(served.contract, params, context);
		this.#placement.assertHere(served.contract, checked.params);
		const object = this.#object(served, checked, principal, context, chain);
		const activation = object.activationId;
		if (activation !== undefined && chain.includes(activation)) throw this.cycle(chain, activation, [object.label]);
		return object;
	}

	/**
	 * The path a remote reference of `Type` with `params` acting as `principal` goes over now: `ref.retry()` places a
	 * reference failed for a part past the limits anew (a route may have forgotten its old path). Throws as
	 * `Placement.reference` does, and `unavailable` for a type served here now.
	 */
	pathOf(Type: Contract, params: ParamsOf<Contract>, principal: Principal | undefined): Path {
		// A retry has no context of its own: its admission checks count on none.
		const placed = this.#placement.reference(Type, params, principal, BACKGROUND_CONTEXT);
		if (placed.kind === "path") return placed.path;
		throw new ChordError({ code: "unavailable", message: `${Type.name} is served here now` });
	}

	/**
	 * The `invalid/cycle` error of a cycle through `chain` (Q5): its entries from the activation `id` on, by label
	 * where the object is on this host ("…" for other hosts'), then `closing`.
	 */
	cycle(chain: readonly string[], id: string, closing: readonly string[]): ChordError {
		const labels = new Map([...this.#objects.values()].map((each) => [each.activationId, each.label]));
		const cycle = chain.slice(chain.indexOf(id)).map((entry) => labels.get(entry) ?? "…");
		return invalid("cycle", `dependency cycle: ${[...cycle, ...closing].join(" → ")}`);
	}

	/** A new origin number for `side`, which relays holds upstream; registered in `relays` until it closes. */
	relayOrigin(side: ProviderSide): number {
		const origin = this.#nextOrigin++;
		this.relays.set(origin, side);
		return origin;
	}

	/**
	 * A route's link, its work under the route's `context`: registered with the host and its heartbeat; one closed
	 * already is returned closed.
	 */
	routeLink(link: Link, options: LinkOptions<Principal>, context: Context): HostLink {
		return this.#link(link, "route", options, context);
	}

	/** A link completed its handshake: a route's resets its address's backoff. */
	linkOpened(link: HostLink): void {
		if (link.role !== "route") return;
		for (const route of this.#routes.values()) route.opened(link);
	}

	/**
	 * Forgets a link once it closed: the origins relaying to it, then the parent's path or its route's address are
	 * told; the heartbeat may stop.
	 */
	unlink(link: HostLink): void {
		this.#links.delete(link);
		for (const relay of this.relays.values()) relay.unlinked(link);
		if (this.#links.size === 0) {
			clearInterval(this.#ticking);
			this.#ticking = undefined;
		}
		if (link.role === "parent") this.#parent.disconnected(link);
		if (link.role === "route") for (const route of this.#routes.values()) if (route.closed(link)) break;
	}

	/** Moves `object` behind every object that went live before it (close ends in reverse); its backoff is over. */
	wentLive(object: ChordObject): void {
		this.#objects.delete(object.identity);
		this.#objects.set(object.identity, object);
		this.backoff.delete(object.identity);
	}

	/** Drops an ended object (once, before a next instance of its identity exists). */
	forget(object: ChordObject): void {
		this.#objects.delete(object.identity);
		this.backoff.ended(object.identity);
	}

	/** Records a teardown for `identity`: its next attempt waits for it and for every earlier one still running. */
	ending(identity: string, teardown: Promise<void>): void {
		const previous = this.#endings.get(identity);
		const ending = previous === undefined ? teardown : Promise.all([previous, teardown]).then(() => {});
		this.#endings.set(identity, ending);
		void ending.then(() => {
			if (this.#endings.get(identity) === ending) this.#endings.delete(identity);
		});
	}

	/** What the next attempt for `identity` waits for: its previous instances' teardowns, if any still run. */
	endingOf(identity: string): Promise<void> | undefined {
		return this.#endings.get(identity);
	}

	/**
	 * A reference to `Type` made by `caller` for `host.hold` and getters: params and where it goes checked at once
	 * (`invalid/params`, `#assertRoute`), then bound (a placement or route that fails fails the reference broken);
	 * before `load` resolved, both once it did (a host closed meanwhile releases it).
	 */
	#hold(Type: Contract, params: unknown, caller: Caller, context: Context, options: GetOptions): Binding {
		this.#assertOpen();
		const checked = checkParams(Type, params, context);
		if (this.pendingLoad === undefined) {
			const binding = this.reference(Type, undefined, caller, options);
			this.#bindOrFail(binding, Type, checked, context);
			return binding;
		}
		const binding = this.#binding(Type, undefined, caller, options);
		// Raced with the reference's end: a release before `load` resolved lets go of the binding, its contract and
		// `context` at once (only the race's settled promise stays behind in `load`'s reactions).
		void Promise.race([this.#loaded.promise, binding.ended()]).then(() => {
			// Released while `load` ran: nothing is made for it.
			if (binding.refState.kind === "ended") return;
			if (this.#state === "closed") return binding.end(this.#closedError());
			this.#bindOrFail(binding, Type, checked, context);
		});
		return binding;
	}

	/**
	 * Binds a reference (`bind`); where it cannot go (`#assertRoute`, a placement or `authorize` that throws or refuses)
	 * fails it broken.
	 */
	#bindOrFail(binding: Binding, Type: Contract, checked: CheckedParams, context: Context): void {
		try {
			this.#assertRoute(Type);
			this.bind(binding, Type, checked, context);
		} catch (error) {
			binding.refuse({ kind: "broken", error: asChordError(error, Type.name) });
		}
	}

	/** A new reference's binding made by `caller`; its parked calls wait its `readyTimeout`. */
	#binding(Type: Contract, dependent: ChordObject | undefined, caller: Caller, options: GetOptions): Binding {
		return new Binding(Type, this.batch, dependent, caller, options.readyTimeout ?? this.timeouts.ready);
	}

	/** This host as the maker of its own references: its principal and incarnation. */
	#own(): Caller {
		return { principal: this.principal, incarnation: this.incarnation };
	}

	/** Whether `principal` is this host's own (by principal key): revocation never touches it. */
	#isOwn(principal: Principal, context: Context): boolean {
		const own = this.principal;
		if (own === undefined) return false;
		// Principals on this host are `P`s: its own, and the ones its links stamp.
		return (
			principalKey(own, context, this.#principalKey) === principalKey(principal as P, context, this.#principalKey)
		);
	}

	/** A new link of `role`, registered with the heartbeat while open. */
	#link(link: Link, role: LinkRole, options: LinkOptions<Principal>, context: Context): HostLink {
		const { principal, trusted = false, codec = binaryCodec } = options;
		const limits = linkLimits(trusted, options.limits);
		const made = new HostLink(this, link, { role, principal, trusted, codec, limits }, withoutAbortSignal(context));
		if (!made.open) return made;
		this.#links.add(made);
		if (this.#ticking === undefined) {
			const { ping, close } = this.#heartbeat;
			this.#ticking = setInterval(() => {
				const now = Date.now();
				for (const each of [...this.#links]) each.tick(now, ping, close);
			}, Math.min(ping, close) / 10);
		}
		return made;
	}

	/**
	 * Throws where a reference to `Type` cannot go: a type served here needs the caller's version and fingerprint
	 * (`contract_mismatch`); a local type never crosses a link (`unavailable`). A remote type not served here goes on (a
	 * route or the parent link), open yet or not.
	 */
	#assertRoute(Type: Contract): void {
		const served = this.#types.get(Type.name);
		if (served === undefined) {
			if (Type.kind === "local") {
				throw new ChordError({ code: "unavailable", message: `${Type.name} is not served here` });
			}
			return;
		}
		this.#assertMatch(served, Type.version, Type.fingerprint);
	}

	/**
	 * The object for `params` (checked by L1) and, for a remote type, `principal` (its key is part of the identity),
	 * created if there is none; its first attempt starts at once, or when its identity's backoff window ends. A new one
	 * keeps the activation chain it is created for (Q5): `chain` (a hold's), or that of `dependent`'s activation when
	 * an activation declared it, so its own holds over links carry that chain on.
	 */
	#object(
		served: Served,
		params: CheckedParams,
		principal: Principal | undefined,
		context: Context,
		chain: readonly string[] = NO_CHAIN,
		dependent?: ChordObject,
	): ChordObject {
		const { key, params: checked } = params;
		const identity =
			served.kind === "local"
				? identityKey(served.contract, key)
				: // A host serving remote types has a principal, which its references act as unless a
					// link stamped its own (only `P`s).
					identityKey(served.contract, key, principalKey(principal as P, context, this.#principalKey));
		let object = this.#objects.get(identity);
		if (object === undefined) {
			// Shared by every getter: one getter's cancellation does not cancel it.
			const owner = served.kind === "local" ? undefined : principal;
			const created = dependent?.activationChain() ?? chain;
			object = new ChordObject(this, served, checked, owner, key, identity, withoutAbortSignal(context), created);
			this.#objects.set(identity, object);
			if (!this.backoff.waiting(identity)) object.attempt();
		}
		return object;
	}

	/**
	 * Closes the links, then ends every object at once and tears them down one by one, the last to go live first, after
	 * the endings already running.
	 */
	async #close(): Promise<void> {
		this.#state = "closed";
		this.#routing.abort(this.#closedError());
		// Links first, children, routes, then the parent: no `gone` goes out for the objects ending below.
		const links = [...this.#links];
		for (const role of ["child", "route", "parent"]) for (const link of links) if (link.role === role) link.close();
		// Remote references end now: their parked calls reject `released`, no later link holds them.
		const closed = this.#closedError();
		const holders = [
			...this.#parent.holders(),
			...this.unplaced.holders(),
			...[...this.#routes.values()].flatMap((route) => route.close()),
		];
		for (const holder of holders) if (holder.kind === "remote") holder.lost(closed);
		this.backoff.clear();
		// Every object is sealed before any teardown releases a reference, so none ends in the background.
		const teardowns = [...this.#objects.values()].reverse().map((object) => object.stop());
		await Promise.all(this.#endings.values());
		const failures: CloseFailed[] = [];
		for (const tearDown of teardowns) failures.push(...(await tearDown()));
		this.#types.clear();
		this.store?.detach();
		// Gets waiting for a load that will not come fail now.
		this.#loaded.resolve();
		if (failures.length > 0) {
			const message = `host.close: ${failures.length} native close(s) threw`;
			throw new AggregateError(
				failures.map(({ error }) => error),
				message,
			);
		}
	}

	/** The store stopped after a backend error (it tells the host once): reported, and the host closes. */
	#storageFailed(error: unknown): void {
		this.report({ kind: "storage_failed", error });
		this.#closing ??= this.#close();
		// The app's own `close` returns this closing and gets its failures.
		this.#closing.catch(() => {});
	}

	/** A backoff window ended: the identity's object is retried; without one the entry goes. */
	#due(identity: string): void {
		const object = this.#objects.get(identity);
		if (object === undefined) this.backoff.delete(identity);
		else object.attempt();
	}

	/** Runs every facet's setup, checking the plugin names (npm names, each once), and serves what they declared. */
	#setUp(facets: readonly { readonly name: string; readonly facet: Facet<P> }[]): void {
		const names = new Set<string>();
		for (const { name, facet } of facets) {
			if (!PLUGIN_NAME.test(name)) throw new Error(`"${name}" is not a valid plugin name`);
			if (names.has(name)) throw new Error(`plugin "${name}" is loaded twice`);
			names.add(name);
			for (const entry of setUp(name, facet, (Type) => this.references(Type))) this.#serve(entry);
		}
	}

	#serve({ contract, factory, options }: ServedEntry): void {
		if (this.#types.has(contract.name)) throw new Error(`${contract.name} is served twice`);
		// A client serves only local types (§3): a remote object is owned by a principal of the host serving it.
		if (contract.kind === "remote" && this.principal === undefined) {
			throw new Error(`${contract.name}: a host without a principal serves only local types`);
		}
		const common = { provider: bindProvider(contract, {}), linger: options.linger ?? 0 };
		// The contract's kind decides the factory's signature and the contract's shape.
		const served: Served =
			contract.kind === "local"
				? {
						...common,
						kind: "local",
						contract: contract as LocalContract,
						factory: factory as Extract<Served, { kind: "local" }>["factory"],
						hostLifetime: contractData(contract).params.fields.length === 0,
					}
				: {
						...common,
						kind: "remote",
						contract: contract as RemoteContract,
						factory: factory as Extract<Served, { kind: "remote" }>["factory"],
					};
		this.#types.set(contract.name, served);
	}

	#assertMatch(served: Served, version: number, fingerprint: string): void {
		if (version !== served.contract.version || fingerprint !== served.contract.fingerprint) {
			const message = `${served.contract.name} v${version} does not match the served v${served.contract.version}`;
			throw new ChordError({ code: "contract_mismatch", message });
		}
	}

	#assertOpen(): void {
		if (this.#state === "closed") throw this.#closedError();
	}

	#closedError(): ChordError {
		return new ChordError({ code: "released", reason: "closed", message: "the host is closed" });
	}
}
