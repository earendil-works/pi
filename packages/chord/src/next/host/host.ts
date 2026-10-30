// Hosts (§3): `createHost`, loading facets and the start barrier, links to children, the parent (connected again after
// a drop) and routes, the origins it relays holds for, getting and holding references as a principal, the heartbeat
// of every link, revocation (§4), presence (§19) and keep-alive counts, registries and root scopes (slice 8), reloads
// (slice 7b: staging, the commit, each object's fate, the report), closing; one batch per host, the backoff map and the
// endings new instances wait for.

import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	type Context,
	withAbortSignal,
	withoutAbortSignal,
} from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Watchable } from "../../watch.ts";
import type { Address, Contract, HostKind, ParamsOf } from "../contracts/index.ts";
import { contractData, type Params } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal, type PrincipalKeyFunction } from "../data/index.ts";
import {
	asChordError,
	binds,
	canonicalJson,
	checkParams,
	identityKey,
	invalid,
	principalKey,
} from "../data/internal.ts";
import { binaryCodec, type Codec, type Compression, type Link, type PartLimits } from "../link/index.ts";
import { linkLimits } from "../link/internal.ts";
import type { Registry, RegistryValue } from "../registries/index.ts";
import type { RegistryValueSource } from "../registries/internal.ts";
import { type RegistryContribution, type RegistryError, RegistryRecord } from "../registries/internal.ts";
import {
	type HoldRequest,
	HostLink,
	type LinkRole,
	Path,
	type ProviderSide,
	RemoteObject,
	type Upstream,
} from "../remote/internal.ts";
import { Batch, type BatchError } from "../state/internal.ts";
import type { ChordStore, Store } from "../store/store.ts";
import { Activity, type ActivityCounts } from "./activity.ts";
import { type Attempt, notLive } from "./attempt.ts";
import { Backoff } from "./backoff.ts";
import { type Caller, type Ctx, withLinkedAbortSignal } from "./ctx.ts";
import { Destination, type Placed } from "./destination.ts";
import type { Facet } from "./facet.ts";
import { contributionOf } from "./members.ts";
import type { CloseFailed } from "./native.ts";
import { ChordObject, type Holder, type ReloadFate, type Served } from "./object.ts";
import { type Presence, References } from "./presence.ts";
import { Binding, type CheckedParams, type Held, type Reference, type Target } from "./reference.ts";
import { RevocationKeys, type RevokedBy } from "./revocation.ts";
import { type RootOptions, RootScopes } from "./root.ts";
import { Route, type RouteOptions } from "./route.ts";
import {
	addStaged,
	emptyStaged,
	type PluginFacet,
	type Recorded,
	type Request,
	recordFactory,
	type Staged,
	type StagedPlugin,
	type StagedRegistry,
	type StagingHost,
	stagePlugin,
} from "./staging.ts";
import { UnboundIndex, type UnboundRequest } from "./unbound.ts";
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
	| RegistryError
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
	| { readonly kind: "job_dropped"; readonly object: string; readonly job: string; readonly id: string }
	/**
	 * An attempt parked longer than `readyTimeout` (since `since`, `Date.now()` time), whatever its blocker: once per
	 * parking episode, naming the first blocker in declaration order (`waitingFor`, a reference's label or `registry
	 * <name>`) and its `state`; a diagnostic of a ring across hosts started at the same moment or a long wait (nothing
	 * fails).
	 */
	| {
			readonly kind: "parked_long";
			readonly object: string;
			readonly waitingFor: string;
			readonly state: "loading" | "failed";
			readonly since: number;
	  };

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
export type AnyHost = Omit<ChordHost, "load" | "reload" | "accept" | "connect" | "route" | "references" | "root">;

/** A host. `P` is the app's principal type, `R` its revocation type. */
export interface Host<P extends Principal = Principal, R extends JsonValue = JsonValue> {
	/**
	 * Runs every facet's setup and publishes what they declared in one batch (the types and registries served, the
	 * registries composed once, the contributions); requests that waited for the publication are placed after that
	 * batch. Then activates every served type with empty params and resolves when each has had its first outcome (the
	 * start barrier, decision (a)): live, failed by its own cause, parked with no blocker here still without its first
	 * outcome, or ended (failures go to `onError`). A plugin whose setup throws or is refused at declaration (its name,
	 * a type or registry another plugin serves, a remote type here without principal or address, `checkAccepts`) is
	 * left out and reported (`failed`); it never closes the host. Runs once.
	 */
	load(facets: readonly PluginFacet<P>[], context: Context): Promise<LoadReport>;
	/**
	 * Reloads this host's plugins (slice 7b): `facets` is its complete new plugin set; a plugin in it and not loaded
	 * is added, one loaded with another facet value is changed (the same facet object is unchanged: untouched), one
	 * loaded and not in it is removed. Staging runs every new setup and every affected object's new factory against a
	 * recording `self`, per plugin: a plugin whose new code fails there keeps its old code (an added one is left out),
	 * and so does a changed plugin whose recorded requests would not bind because of it (the closure rule); both are
	 * reported (`failed`); `options.failed` names plugins the caller passes as their loaded facet because their new
	 * code failed before (a build, an evaluation): the same for the closure rule and the report. Then it commits in one
	 * batch (types, registries,
	 * contributions; a publication waking the requests for the names it serves) and every object of a changed or
	 * removed plugin takes its fate: swapped in place, restarted after its drain, retried, or ended (its type
	 * removed). Resolves with the report once every fate started (swaps and retries checked their dependencies; it
	 * does not wait for objects to go live). Reloads run one after another. Throws before `load` resolved; rejects
	 * `released/closed` after `close`; `context`'s abort before the commit rejects `aborted` and changes nothing, after
	 * it only ends the wait (`aborted`, its `details.committed` naming what the commit applied: `CommittedReload`).
	 */
	reload(facets: readonly PluginFacet<P>[], context: Context, options?: ReloadOptions): Promise<ReloadReport>;
	/**
	 * A reference once its object is live (and hydrated). It acts as the host's principal and goes where its type's host
	 * address puts it: here, over a route, or over the parent link (`Destination`). It waits while the reference is
	 * `loading` (before the host's publication too), `failed { transient }` or `failed { waiting }` until its
	 * `readyTimeout`, then rejects with the last cause and releases the reference; a broken failure rejects at once.
	 */
	get<C extends Contract>(Type: C, params: ParamsOf<C>, context: Context, options?: GetOptions): Promise<Reference<C>>;
	/**
	 * A reference at once, following its object until released: loading, live, failed (retried as its object is) and
	 * loading again while its link is down; it never rejects. Throws at once only for invalid params (also before
	 * `load`). A type not served where it goes is `loading` before the host's publication and `failed { waiting }` after
	 * it (bound when a publication serves it); a `hostAddress` or route that refuses fails it broken. Its `variant` is
	 * `undefined` until its first binding.
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
	 * Registry `R`'s composed value as `R`'s version sees it, for code outside objects, once it is usable: waits for the
	 * host's publication, then while it has no value (`unavailable/undeclared` without a provider, a first `compose`
	 * that threw, a version not served here: `contract_mismatch`) until its `readyTimeout`, then rejects with the last
	 * error.
	 */
	registry<C, V>(R: Registry<C, V>, context: Context, options?: GetOptions): Promise<RegistryValue<V>>;
	/**
	 * Runs `fn` with a call context for code outside objects (a Durable tool, a CLI): the host's principal (or
	 * `options.principal`), this host's incarnation, `context`'s telemetry and signal, `ctx.get`. When `fn` settles or
	 * `context` aborts, the context is sealed: its signal aborted, `ctx.get` refused `released`, every reference it took
	 * released; an abort rejects at once. `host.close` seals the open ones; after it, `root` rejects `released`.
	 */
	root<T>(fn: (ctx: Ctx<P>) => Promise<T>, context: Context, options?: RootOptions<P>): Promise<T>;
	/**
	 * Closes its links, seals its root scopes, then ends every object at once, then drains and closes them one by one,
	 * the last to go live first (reason `close`). Rejects with an `AggregateError` of the closes that threw.
	 */
	close(context: Context): Promise<void>;
}

/** A plugin left out at `load`, or whose new code failed at a reload (it kept its old code, if it had any), and why. */
export type PluginFailure = { readonly plugin: string; readonly error: unknown };

/**
 * What a reload's commit applied, by plugin name: the `details.committed` of the `aborted` error of a reload whose
 * context aborted after its commit (the commit stands; only the wait for the report ended).
 */
export type CommittedReload = {
	readonly added: readonly string[];
	readonly changed: readonly string[];
	readonly removed: readonly string[];
	/** The plugins whose new code failed: they kept their old code (an added one was left out). */
	readonly failed: readonly string[];
};

/** What `host.reload` takes besides the plugin set: the plugins whose new code failed before it (a build, an evaluation). */
export type ReloadOptions = { readonly failed?: readonly PluginFailure[] };

/** What `load` did (decision "Per plugin at startup and reload"): the plugins it left out. */
export type LoadReport = { readonly failed: readonly PluginFailure[] };

/**
 * What a reload did (slice 7b §1): its plugins by change (those applied), the plugins whose new code failed, and what
 * every affected object did.
 */
export type ReloadReport = {
	readonly plugins: {
		readonly added: readonly string[];
		readonly changed: readonly string[];
		readonly removed: readonly string[];
	};
	readonly failed: readonly PluginFailure[];
	/** Every live, activating, parked or failed object of a changed or removed plugin, by its label. */
	readonly objects: readonly ReloadedObject[];
};

/**
 * One object's fate in a reload: `swapped` (pure, in place), `restarted` (natives: drained, closed with reason
 * `reload`, activated again), `ended` (its type is gone), `parked` (its new code waits for a dependency, `cause`), or
 * `retried` (it was failed, parked or activating: a new attempt runs on the new code).
 */
export type ReloadedObject = { readonly object: string } & (
	| { readonly kind: "swapped" }
	| { readonly kind: "restarted" }
	| { readonly kind: "ended" }
	| { readonly kind: "parked"; readonly cause: FailureCause }
	| { readonly kind: "retried" }
);

/**
 * What a hold placed here binds to (`serving`): its object, or why it waits unbound (`failed { waiting }`: not served,
 * another version, or placed elsewhere by the provider's code).
 */
export type Serving =
	| { readonly kind: "object"; readonly object: ChordObject }
	| { readonly kind: "waiting"; readonly cause: FailureCause };

/**
 * A published plugin: its facet (an unchanged reload passes the same object), what its setup staged (a reload that
 * keeps it uses it again, its setup not run) and its contributions in the registries' tables.
 */
type LoadedPlugin<P extends Principal> = {
	readonly facet: Facet<P>;
	readonly staged: StagedPlugin;
	readonly contributions: readonly RegistryContribution[];
};

/**
 * What a reload staged: the staged set, the facets of the plugins it applies, the plugins by change, those that failed,
 * and each affected object's fate.
 */
type ReloadPlan<P extends Principal> = {
	readonly staged: Staged;
	readonly facets: ReadonlyMap<string, Facet<P>>;
	readonly added: readonly string[];
	readonly changed: readonly string[];
	readonly removed: readonly string[];
	readonly failed: readonly PluginFailure[];
	readonly fates: readonly PlannedFate[];
};

/** One staging pass of a reload: its plan, or the plugins it found failing (staging runs again without their new code). */
type StagingPass<P extends Principal> =
	| { readonly kind: "staged"; readonly plan: ReloadPlan<P>; readonly recorded: readonly RecordedFactory[] }
	| { readonly kind: "failed"; readonly failed: ReadonlyMap<string, unknown> };

/** A recorded new factory of an object staging planned a fate for: whose new code it is, and what it declared. */
type RecordedFactory = { readonly plugin: string; readonly recorded: Recorded };

/** An affected object's fate, as staging decided it. */
type PlannedFate =
	| { readonly kind: "end"; readonly object: ChordObject }
	| { readonly kind: ReloadFate; readonly object: ChordObject; readonly served: Served };

/** A fate started by a reload's commit, for its report: a swap's or retry's new attempt is checked first. */
type StartedFate =
	| { readonly object: string; readonly kind: "ended" }
	| { readonly object: string; readonly kind: "swapped" | "restarted" | "retried"; readonly attempt: Attempt };

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
	/** The served types by name: the published plugin set's (a reload's commit replaces it). */
	#types = new Map<string, Served>();
	/** The published plugins by name: their facet (an unchanged one is the same object), registries and contributions. */
	readonly #plugins = new Map<string, LoadedPlugin<P>>();
	/** The reloads, one after another (slice 7b §1): the last one's end, which the next one waits for. */
	#reloading: Promise<void> = Promise.resolve();
	/** By identity, in the order they went live (the others where they were created). */
	readonly #objects = new Map<string, ChordObject>();
	/** Teardowns still running, by identity: the next instance of an identity waits for its previous ones. */
	readonly #endings = new Map<string, Promise<void>>();
	/** The requests that cannot bind yet, by name: before the publication all of them, then those left unbound. */
	readonly #unbound = new UnboundIndex();
	/** Resolved at the host's first publication (`load`'s batch), or its close. */
	readonly #publication = Promise.withResolvers<void>();
	#published = false;
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
	readonly #destination: Destination;
	/** The downstream origins this host relays holds for, by their number on upstream links (never reused). */
	readonly relays = new Map<number, ProviderSide>();
	#nextOrigin = 1;
	/** Aborted when the host closes: the context of every route's `resolve`, and the end of waiting `host.registry`s. */
	readonly #routing = new AbortController();
	readonly #heartbeat: { readonly ping: number; readonly close: number };
	/** Its registries by name, each made by its first use (a serve, a contribution or a reader). */
	readonly #registries = new Map<string, RegistryRecord>();
	readonly #roots = new RootScopes(this);
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
		this.#destination = new Destination(this.address, this.#routes, this.#parent);
		// Chord's own: `openStore` made it.
		this.store = options.store as ChordStore | undefined;
		this.store?.attach({ failed: (error) => this.#storageFailed(error), batch: this.batch });
	}

	async load(facets: readonly PluginFacet<P>[], context: Context): Promise<LoadReport> {
		this.batch.assertOutside("load");
		this.#assertOpen();
		if (this.#state !== "new") throw new Error("load runs once per host");
		this.#state = "loading";
		const staged = emptyStaged();
		const loaded = new Map<string, Facet<P>>();
		const failed: PluginFailure[] = [];
		// A name given twice is refused the second time whether or not the first staged.
		const given = new Set<string>();
		// In the given order: of two plugins serving one name, the later is left out.
		for (const plugin of facets) {
			const twice = given.has(plugin.name);
			given.add(plugin.name);
			const error = twice ? loadedTwice(plugin.name) : this.#stageInto(staged, plugin);
			if (error === undefined) loaded.set(plugin.name, plugin.facet);
			else failed.push({ plugin: plugin.name, error });
		}
		this.#types = staged.types;
		// The publication: the types and registries served, the facets' contributions and the first composition of
		// every served registry, in one batch, before any object activates.
		this.batch.commit(() => {
			this.#publish(staged, loaded);
			for (const record of this.#registries.values()) record.composeServed();
		}, context);
		// After the batch: what waited for the publication is placed (the gate lasted only for the setups).
		this.#published = true;
		this.#publication.resolve();
		this.#unbound.wakeAll();
		const objects = [...this.#types.values()]
			.filter((served) => served.kind === "local" && served.hostLifetime)
			.map((served) => this.#object(served, EMPTY_PARAMS, undefined, context));
		await Promise.all(objects.map(({ firstOutcome }) => firstOutcome));
		if (this.#state === "loading") this.#state = "loaded";
		return { failed };
	}

	/**
	 * Whether a request for `Type` with `params` binds to `served` as a real bind checks it (`bind`): its kind, version
	 * and fingerprint, and the provider's own host address; one whose `hostAddress` throws does not.
	 */
	#wouldBind(served: Served, Type: Contract, params: ParamsOf<Contract>): boolean {
		if (unboundCause(served, Type.kind, Type.name, Type.version, Type.fingerprint) !== undefined) return false;
		try {
			return this.#misplaced(Type, served, params) === undefined;
		} catch {
			return false;
		}
	}

	/** Whether a request for `Type` with `params` goes here; a `hostAddress` that throws: not here (it fails at bind). */
	#placedHere(Type: Contract, params: ParamsOf<Contract>): boolean {
		try {
			return this.#destination.placedHere(Type, params);
		} catch {
			return false;
		}
	}

	/** Stages `plugin`'s new code into `staged`: the error that refuses it (its setup, a declaration, a name served twice). */
	#stageInto(staged: Staged, plugin: PluginFacet<P>): unknown {
		try {
			return addStaged(staged, stagePlugin(plugin, this.#stagingHost()));
		} catch (error) {
			return error;
		}
	}

	reload(facets: readonly PluginFacet<P>[], context: Context, options: ReloadOptions = {}): Promise<ReloadReport> {
		this.batch.assertOutside("reload");
		if (this.#state === "closed") return Promise.reject(this.#closedError());
		if (this.#state !== "loaded") throw new Error("reload runs after load");
		const reload = this.#reloading.then(() => this.#reload(facets, options.failed ?? [], context));
		// The tail settles to nothing: a report kept as its value would keep a rejected facet's closure (its error).
		this.#reloading = reload.then(
			() => {},
			() => {},
		);
		return reload;
	}

	/** One reload, after the previous one: staging, the commit, the fates, the report. */
	async #reload(
		facets: readonly PluginFacet<P>[],
		before: readonly PluginFailure[],
		context: Context,
	): Promise<ReloadReport> {
		this.#assertOpen();
		if (context.abortSignal?.aborted) throw reloadAborted();
		const plan = this.#stageReload(facets, before, context);
		// Aborted while it staged (a setup may abort it synchronously): nothing changed.
		if (context.abortSignal?.aborted) throw reloadAborted();
		const started = this.#commit(plan, context);
		const { added, changed, removed, failed } = plan;
		const plugins = { added, changed, removed };
		const committed: CommittedReload = { ...plugins, failed: failed.map(({ plugin }) => plugin) };
		const objects = await this.#report(started, committed, context);
		return { plugins, failed, objects };
	}

	/**
	 * Staging (slice 7b §2), synchronous (no request or arriving hold meets it half done), per plugin (decision "Per
	 * plugin at startup and reload"): a pass stages the new code (`#stagePass`); a plugin whose new code fails there
	 * (or failed `before`, passed as its loaded facet) keeps its old code (an added one is left out) and staging runs
	 * again without it; then a changed plugin whose recorded requests would not bind because of such a plugin keeps its
	 * old code too (`#closure`), until nothing more fails. Bounded by the number of plugins with new code.
	 */
	#stageReload(facets: readonly PluginFacet<P>[], before: readonly PluginFailure[], context: Context): ReloadPlan<P> {
		const failed = new Map(before.map(({ plugin, error }) => [plugin, error]));
		const given = new Map<string, Facet<P>>();
		// A name given twice: the second is refused, the first staged.
		const twice: PluginFailure[] = [];
		for (const { name, facet } of facets) {
			if (given.has(name)) twice.push({ plugin: name, error: loadedTwice(name) });
			else given.set(name, facet);
		}
		for (;;) {
			const pass = this.#stagePass(given, failed, context);
			if (pass.kind === "failed") {
				for (const [name, error] of pass.failed) failed.set(name, error);
				continue;
			}
			const kept = this.#closure(pass.plan, pass.recorded, failed);
			if (kept.size > 0) {
				for (const [name, error] of kept) failed.set(name, error);
				continue;
			}
			const failures = [...failed].map(([plugin, error]) => ({ plugin, error }));
			return { ...pass.plan, failed: [...twice, ...failures] };
		}
	}

	/**
	 * One staging pass: the loaded entries of the plugins kept as they are (unchanged, or failed: their setups not run
	 * again) first, then every other plugin's new code in the given order (one refused by a name the table has already
	 * fails), then the new factory of every object of a changed or removed plugin whose type is still served (a throw
	 * fails the plugin serving it). Its plan, or the plugins that failed.
	 */
	#stagePass(
		given: ReadonlyMap<string, Facet<P>>,
		failed: ReadonlyMap<string, unknown>,
		context: Context,
	): StagingPass<P> {
		const staged = emptyStaged();
		const failing = new Map<string, unknown>();
		const fresh: PluginFacet<P>[] = [];
		for (const [name, facet] of given) {
			const loaded = this.#plugins.get(name);
			if (loaded !== undefined && (loaded.facet === facet || failed.has(name))) addStaged(staged, loaded.staged);
			else if (!failed.has(name)) fresh.push({ name, facet });
		}
		for (const plugin of fresh) {
			const error = this.#stageInto(staged, plugin);
			if (error !== undefined) failing.set(plugin.name, error);
		}
		if (failing.size > 0) return { kind: "failed", failed: failing };
		const applied = new Set(fresh.map(({ name }) => name));
		const removed = [...this.#plugins.keys()].filter((name) => !given.has(name));
		const reloaded = new Set([...applied, ...removed]);
		const fates: PlannedFate[] = [];
		const recorded: RecordedFactory[] = [];
		for (const object of this.#objects.values()) {
			if (!reloaded.has(object.served.plugin)) continue;
			const served = staged.types.get(object.served.contract.name);
			if (served === undefined || served.kind !== object.served.kind) {
				fates.push({ kind: "end", object });
				continue;
			}
			try {
				const declared = recordFactory(object, served, context);
				recorded.push({ plugin: served.plugin, recorded: declared });
				fates.push({ kind: object.reloadFate(declared), object, served });
			} catch (error) {
				if (!failing.has(served.plugin)) failing.set(served.plugin, error);
			}
		}
		if (failing.size > 0) return { kind: "failed", failed: failing };
		const facets = new Map(fresh.map(({ name, facet }) => [name, facet]));
		const added = fresh.filter(({ name }) => !this.#plugins.has(name)).map(({ name }) => name);
		const changed = fresh.filter(({ name }) => this.#plugins.has(name)).map(({ name }) => name);
		const plan = { staged, facets, added, changed, removed, failed: [], fates };
		return { kind: "staged", plan, recorded };
	}

	/**
	 * The closure rule: the changed plugins (new code applied) of `plan` with a recorded request that would not bind in
	 * the staged table because of a plugin that failed in this reload: its name served there by such a plugin's old code,
	 * or not served at all while some plugin failed (what a failed setup would have served is unknown). Requests to
	 * another host are not checked (a rollout's rules). Each such plugin with the error it keeps its old code for.
	 */
	#closure(
		plan: ReloadPlan<P>,
		recorded: readonly RecordedFactory[],
		failed: ReadonlyMap<string, unknown>,
	): Map<string, unknown> {
		const kept = new Map<string, unknown>();
		if (failed.size === 0) return kept;
		for (const { plugin, recorded: declared } of recorded) {
			if (kept.has(plugin) || !plan.facets.has(plugin)) continue;
			for (const request of declared.requests) {
				const unbound = this.#unboundRequest(plan.staged, request, failed);
				if (unbound === undefined) continue;
				kept.set(plugin, new Error(`plugin "${plugin}": ${unbound}`));
				break;
			}
		}
		return kept;
	}

	/**
	 * Why `request` (of a new factory) would not bind in `staged` because of a plugin in `failed`; `undefined`
	 * when it binds, is placed on another host, or does not bind for another reason (it waits as any request does).
	 */
	#unboundRequest(staged: Staged, request: Request, failed: ReadonlyMap<string, unknown>): string | undefined {
		const name = request.kind === "type" ? request.contract.name : request.registry.name;
		const provider = request.kind === "type" ? staged.types.get(name)?.plugin : staged.registries.get(name)?.plugin;
		if (provider !== undefined && !failed.has(provider)) return undefined;
		if (request.kind === "type") {
			const { contract, params } = request;
			// A remote type the object reaches on another host: placed by the rollout's rules, not this host's.
			if (!this.#placedHere(contract, params)) return undefined;
			const served = staged.types.get(name);
			if (served !== undefined && this.#wouldBind(served, contract, params)) return undefined;
			return provider === undefined
				? `needs ${name} v${contract.version}, which no plugin serves now (a plugin failed)`
				: `needs ${name} v${contract.version}, which plugin "${provider}" serves on its old code`;
		}
		const served = staged.registries.get(name);
		if (served !== undefined && registryServes(served, request.registry.version)) return undefined;
		return provider === undefined
			? `needs registry ${name} v${request.registry.version}, which no plugin serves now (a plugin failed)`
			: `needs registry ${name} v${request.registry.version}, which plugin "${provider}" serves on its old code`;
	}

	/**
	 * The commit (slice 7b §3), one batch: the served types become the staged ones (an unchanged plugin's stay as
	 * they were), the removed plugins' registry providers go and the reloaded ones' are replaced, their facet
	 * contributions replaced by plugin, every changed registry composed once; a removed type's presence list goes.
	 * Then each object takes its fate, host-lifetime objects of new types start, and the publication wakes the
	 * requests waiting for the names the reload serves.
	 */
	#commit(plan: ReloadPlan<P>, context: Context): readonly StartedFate[] {
		const { staged, changed, removed } = plan;
		const published = new Set(plan.facets.keys());
		// A kept plugin's types are its loaded ones, as they are: its objects are untouched.
		const types = staged.types;
		this.batch.commit(() => {
			for (const name of [...changed, ...removed]) {
				const loaded = this.#plugins.get(name)!;
				for (const registry of loaded.staged.registries.keys()) {
					if (staged.registries.get(registry)?.plugin !== name) this.registryRecord(registry).unserve();
				}
				for (const contribution of loaded.contributions) contribution.record.remove(contribution);
				this.#plugins.delete(name);
			}
			this.#types = types;
			this.#publish(staged, plan.facets);
			for (const name of published) {
				for (const registry of staged.plugins.get(name)!.registries.keys()) {
					this.registryRecord(registry).composeServed();
				}
			}
		}, context);
		for (const name of this.#references.keys()) if (!types.has(name)) this.#references.delete(name);
		const names = new Set<string>();
		for (const [name, served] of types) if (published.has(served.plugin)) names.add(name);
		for (const [name, { plugin }] of staged.registries) if (published.has(plugin)) names.add(name);
		const started = plan.fates.map((fate) => this.#startFate(fate));
		for (const type of types.values()) {
			if (type.kind === "local" && type.hostLifetime) this.#object(type, EMPTY_PARAMS, undefined, context);
		}
		this.#unbound.wake(names);
		return started;
	}

	/**
	 * Starts one object's fate after the commit (slice 7b §4): a removed type's object ends, its holders waiting
	 * `not_served`; any other swaps, restarts or retries on its new served type.
	 */
	#startFate(fate: PlannedFate): StartedFate {
		const { object } = fate;
		if (fate.kind === "end") {
			const error = new ChordError({
				code: "unavailable",
				message: `${object.served.contract.name} is not served here`,
			});
			object.remove({ kind: "waiting", error });
			return { object: object.label, kind: "ended" };
		}
		const attempt = object.reload(fate.served, fate.kind);
		return { object: object.label, kind: STARTED[fate.kind], attempt };
	}

	/**
	 * The report, once every swap and retry had its first dependency check (a parked one reports why); restarts are
	 * reported at once (their check follows the drain). `context`'s abort ends only this wait (`aborted`, its `details`
	 * naming what the commit applied: `committed`).
	 */
	async #report(
		started: readonly StartedFate[],
		committed: CommittedReload,
		context: Context,
	): Promise<ReloadedObject[]> {
		const checks = started.map(async (fate): Promise<ReloadedObject> => {
			if (fate.kind === "ended" || fate.kind === "restarted") return { object: fate.object, kind: fate.kind };
			const cause = await fate.attempt.checked;
			return cause === undefined
				? { object: fate.object, kind: fate.kind }
				: { object: fate.object, kind: "parked", cause };
		});
		try {
			return await awaitWithContext(Promise.all(checks), context);
		} catch {
			const { added, changed, removed, failed } = committed;
			const details = {
				committed: { added: [...added], changed: [...changed], removed: [...removed], failed: [...failed] },
			};
			throw new ChordError({ code: "aborted", message: "reload: aborted after its commit", details });
		}
	}

	/** This host as staging sees it: whom it acts as, its address and its presence lists. */
	#stagingHost(): StagingHost {
		// Setups get presence lists of this host's `P`; staging passes them on as they are.
		const references = (Type: Contract) => this.references(Type);
		return { principal: this.principal, address: this.address, references: references as StagingHost["references"] };
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
		// Requests not bound (waiting for the publication or a provider, refused, waiting for their link) end too: nothing
		// revives them.
		const unbound = error("an unbound request");
		this.#unbound.revoke(revoked, unbound);
		for (const link of this.#links) link.revokeUnbound(revoked, unbound);
		// This host's own requests over its paths, linked or not (a route still resolving, a link down): a later link
		// would hold them again (fix round 1).
		for (const holder of this.#pathHolders()) {
			if (holder.kind !== "remote") continue;
			const { principal } = holder.caller;
			if (principal !== undefined && revoked(principal)) holder.revoke(error(holder.label));
		}
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

	async registry<C, V>(R: Registry<C, V>, context: Context, options: GetOptions = {}): Promise<RegistryValue<V>> {
		this.batch.assertOutside("registry");
		this.#assertOpen();
		const timeout = options.readyTimeout ?? this.timeouts.ready;
		const expired = new AbortController();
		const waiting = withLinkedAbortSignal(expired.signal, context);
		let last: unknown;
		const deadline = setTimeout(() => expired.abort(last ?? notLive(`registry ${R.name}`, timeout)), timeout);
		// The host's close ends the wait at once, `released/closed` (its timer with it).
		const closing = (): void => expired.abort(this.#closedError());
		this.#routing.signal.addEventListener("abort", closing, { once: true });
		try {
			await awaitWithContext(this.#publication.promise, waiting.context);
			this.#assertOpen();
			const value = this.registryRecord(R.name).value(R.version);
			// Its values are the composition as `R`'s version has it, `V`.
			const usable = (): boolean => {
				const start = value.start();
				if (start.kind === "value" || start.last !== undefined) return true;
				last = start.error;
				return false;
			};
			if (!usable()) await untilUsable(value, usable, waiting.context);
			return value as RegistryValue<V>;
		} finally {
			clearTimeout(deadline);
			this.#routing.signal.removeEventListener("abort", closing);
			waiting.release();
		}
	}

	async root<T>(fn: (ctx: Ctx<P>) => Promise<T>, context: Context, options: RootOptions<P> = {}): Promise<T> {
		this.batch.assertOutside("root");
		this.#assertOpen();
		// The scope's ctx acts as `principal`, a `P`.
		return this.#roots.run(fn as (ctx: Ctx) => Promise<T>, options.principal ?? this.principal, context);
	}

	/** The record of registry `name` on this host, made by its first use. */
	registryRecord(name: string): RegistryRecord {
		let record = this.#registries.get(name);
		if (record === undefined) {
			record = new RegistryRecord(name, this.batch, (error) => this.report(error));
			this.#registries.set(name, record);
		}
		return record;
	}

	async close(_context: Context): Promise<void> {
		this.batch.assertOutside("close");
		this.#closing ??= this.#close();
		return this.#closing;
	}

	/**
	 * Whether the host published its setups (`load`'s batch): until then requests made here and holds arriving wait in
	 * the unbound index, placed by the publication.
	 */
	get published(): boolean {
		return this.#published;
	}

	/** `request` cannot bind yet: indexed under `name` (the type or registry it waits for) until woken or ended. */
	index(name: string, request: UnboundRequest): void {
		this.#unbound.add(name, request);
	}

	/**
	 * `binding`, whose object left it (its type removed, its version no longer bound: slice 7b §6), waits unbound with
	 * `cause` under its type's name; a publication places it again (`params` checked as it was, under `context`).
	 */
	rewait(binding: Binding, Type: Contract, params: CheckedParams, cause: FailureCause, context: Context): void {
		this.#wait(binding, Type.name, cause, () => this.#place(binding, Type, params, context));
	}

	/** `request` left the unbound index's wait for `name` (it ended, or a retry checks it again). */
	unindex(name: string, request: UnboundRequest): void {
		this.#unbound.delete(name, request);
	}

	/** Whether the host closes: its objects end through `close`, not through its links. */
	get closing(): boolean {
		return this.#state === "closed";
	}

	/**
	 * A reference to `Type` made by `caller` (its principal, its origin's incarnation), once it is live (`host.get`,
	 * `ctx.get`): a hold, waited for up to the getter's one deadline, across reconnects and through `loading`,
	 * `failed { transient }` and `failed { waiting }`; a broken failure rejects at once, the deadline with the last
	 * failure's error. A getter that gives up releases its reference.
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
	 * `host.get`, `host.hold` and `ctx.get`).
	 */
	reference(Type: Contract, dependent: ChordObject | undefined, caller: Caller, options: GetOptions): Binding {
		this.#assertOpen();
		return this.#binding(Type, dependent, caller, options);
	}

	/**
	 * Binds `binding` to the object for (Type, params) as its principal where its host address puts it (`Destination`):
	 * the object here, created with its first attempt if there is none, or a remote object held over its path. Placed
	 * here, the check is only against the type served here: not served (or of the other kind) or not at the caller's
	 * version and fingerprint, the reference waits unbound, `failed { waiting }`, indexed under the type's name. Returns
	 * the object it bound to; throws as `Destination.reference` does (a broken refusal).
	 */
	bind(binding: Binding, Type: Contract, params: CheckedParams, context: Context): Target | undefined {
		const { principal } = binding.caller;
		const placed = this.#destination.reference(Type, params.params, principal, context);
		if (placed.kind === "path") {
			const { caller, dependent } = binding;
			const remote = new RemoteObject(this, Type, params, placed.address, caller, placed.path, dependent);
			placed.path.attach(remote);
			binding.bind(remote);
			return remote;
		}
		const served = this.#types.get(Type.name);
		const unbound =
			unboundCause(served, Type.kind, Type.name, Type.version, Type.fingerprint) ??
			this.#misplaced(Type, served!, params.params);
		if (unbound !== undefined) {
			this.#wait(binding, Type.name, unbound, () => this.#place(binding, Type, params, context));
			return undefined;
		}
		// Checked above: served here at the caller's version.
		const object = this.#object(served!, params, principal, context, NO_CHAIN, binding.dependent);
		binding.bind(object);
		return object;
	}

	/** Where a hold arriving on `link` goes (`Destination.hold`: by the address it names); `released` once the host closed. */
	place(request: HoldRequest, link: HostLink, caller: Caller, context: Context): Placed {
		this.#assertOpen();
		return this.#destination.hold(request, link, caller.principal, context);
	}

	/**
	 * What a hold placed here binds to, acting as `principal`: the object, or why it waits unbound (`failed
	 * { waiting }`): a remote type not served here (`not_served`), not at the hold's version and fingerprint, or whose
	 * params put it on another host (code skew: `version`). Throws for a broken refusal: invalid params, an activation
	 * the hold's chain waits for (`invalid/cycle`, Q5). A new object keeps the hold's chain.
	 */
	serving(request: HoldRequest, params: unknown, principal: Principal, context: Context): Serving {
		const { type, version, fingerprint, chain = NO_CHAIN } = request;
		const served = this.#types.get(type);
		const unbound = unboundCause(served, "remote", type, version, fingerprint);
		if (unbound !== undefined) return { kind: "waiting", cause: unbound };
		// Checked above: a remote type served here.
		const remote = served as Extract<Served, { readonly kind: "remote" }>;
		const checked = checkParams(remote.contract, params, context);
		const misplaced = this.#destination.misplaced(remote.contract, checked.params);
		if (misplaced !== undefined) return { kind: "waiting", cause: { kind: "waiting", error: misplaced } };
		const object = this.#object(remote, checked, principal, context, chain);
		const activation = object.activationId;
		if (activation !== undefined && chain.includes(activation)) throw this.cycle(chain, activation, [object.label]);
		return { kind: "object", object };
	}

	/**
	 * The path a remote reference of `Type` with `params` acting as `principal` goes over now: `ref.retry()` places a
	 * reference failed for a part past the limits anew (a route may have forgotten its old path). Throws as
	 * `Destination.reference` does, and `unavailable` for a type placed here now.
	 */
	pathOf(Type: Contract, params: ParamsOf<Contract>, principal: Principal | undefined): Path {
		// A retry has no context of its own: its admission checks count on none.
		const placed = this.#destination.reference(Type, params, principal, BACKGROUND_CONTEXT);
		if (placed.kind === "path") return placed.path;
		throw new ChordError({ code: "unavailable", message: `${Type.name} is placed here now` });
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
	 * A reference to `Type` made by `caller` for `host.hold` and getters: params checked at once (`invalid/params`,
	 * also before `load`), then placed (`#place`); before the host's publication it waits in the unbound index,
	 * `loading`, and the publication places it.
	 */
	#hold(Type: Contract, params: unknown, caller: Caller, context: Context, options: GetOptions): Binding {
		this.#assertOpen();
		const checked = checkParams(Type, params, context);
		const binding = this.#binding(Type, undefined, caller, options);
		const place = (): void => this.#place(binding, Type, checked, context);
		if (this.#published) place();
		else this.#wait(binding, Type.name, undefined, place);
		return binding;
	}

	/**
	 * Places a reference (`bind`); where it cannot go (a `hostAddress` or `authorize` that throws or refuses) fails it
	 * broken, until `ref.retry()` places it again. One woken after the host closed ends as the close ended the others.
	 */
	#place(binding: Binding, Type: Contract, checked: CheckedParams, context: Context): void {
		if (this.#state === "closed") {
			binding.end(this.#closedError());
			return;
		}
		try {
			this.bind(binding, Type, checked, context);
		} catch (error) {
			const again = (): void => this.#place(binding, Type, checked, context);
			binding.refuse({ kind: "broken", error: asChordError(error, Type.name) }, again);
		}
	}

	/**
	 * The provider's own host-address check of a remote `Type` placed here by the consumer's contract, against the one
	 * served (`invalid/host_address`, `waiting`: code skew); none when both have the same `hostAddress` (the consumer
	 * computed it with the provider's function) or the type is local. A provider's `hostAddress` that throws throws.
	 */
	#misplaced(Type: Contract, served: Served, params: ParamsOf<Contract>): FailureCause | undefined {
		if (served.kind !== "remote" || contractData(Type).hostAddress === contractData(served.contract).hostAddress) {
			return undefined;
		}
		const error = this.#destination.misplaced(served.contract, params);
		return error === undefined ? undefined : { kind: "waiting", error };
	}

	/** Leaves `binding` unbound in the index under `name`: `cause` (`waiting`), or none before the publication. */
	#wait(binding: Binding, name: string, cause: FailureCause | undefined, place: () => void): void {
		binding.wait(cause, place, () => this.#unbound.delete(name, binding));
		this.#unbound.add(name, binding);
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
		// Code outside objects stops at its next use of Chord: an `fn` waiting in `sleep(ms, ctx)` ends.
		this.#roots.close(closed);
		for (const route of this.#routes.values()) route.close();
		for (const holder of this.#pathHolders()) if (holder.kind === "remote") holder.lost(closed);
		// At the fence too: requests still waiting for a publication or a provider end as the others did, and gets
		// waiting for a publication that will not come fail now, not after the slow closes below (fix round 1).
		this.#unbound.close(closed);
		this.#publication.resolve();
		this.backoff.clear();
		// Every object is sealed before any teardown releases a reference, so none ends in the background.
		const teardowns = [...this.#objects.values()].reverse().map((object) => object.stop());
		await Promise.all(this.#endings.values());
		const failures: CloseFailed[] = [];
		for (const tearDown of teardowns) failures.push(...(await tearDown()));
		this.#types.clear();
		// Their facets keep their factories' closures (which may keep objects' handles).
		this.#plugins.clear();
		for (const record of this.#registries.values()) record.close();
		this.#registries.clear();
		this.store?.detach();
		if (failures.length > 0) {
			const message = `host.close: ${failures.length} native close(s) threw`;
			throw new AggregateError(
				failures.map(({ error }) => error),
				message,
			);
		}
	}

	/** Every holder of the parent path, the unplaced one and every route's paths: this host's requests over links. */
	#pathHolders(): Upstream[] {
		const routed = [...this.#routes.values()].flatMap((route) => route.holders());
		return [...this.#parent.holders(), ...this.unplaced.holders(), ...routed];
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

	/**
	 * Publishes the staged plugins of `facets` (by name), inside the publication's batch: the registries they serve
	 * served, their facet contributions entered into the tables (the types are the staged table's, set by the caller).
	 */
	#publish(staged: Staged, facets: ReadonlyMap<string, Facet<P>>): void {
		for (const [name, facet] of facets) {
			const plugin = staged.plugins.get(name)!;
			for (const [registry, { registry: token, provider }] of plugin.registries) {
				this.registryRecord(registry).serve(token.version, provider);
			}
			const contributions = plugin.contributions.map(({ registry, value }) =>
				contributionOf(
					this.registryRecord(registry.name),
					{ plugin: name, type: undefined },
					registry.version,
					value,
				),
			);
			for (const contribution of contributions) contribution.record.add(contribution);
			this.#plugins.set(name, { facet, staged: plugin, contributions });
		}
	}

	#assertOpen(): void {
		if (this.#state === "closed") throw this.#closedError();
	}

	#closedError(): ChordError {
		return new ChordError({ code: "released", reason: "closed", message: "the host is closed" });
	}
}

/**
 * Why a reference to a type of `kind` at `version` and `fingerprint`, placed here, cannot bind to `served` (the type of
 * that name served here): not served, or as the other kind (`unavailable`); another version or fingerprint
 * (`contract_mismatch`); `undefined` when it binds. Both wait for a publication: `failed { waiting }`.
 */
function unboundCause(
	served: Served | undefined,
	kind: Contract["kind"],
	name: string,
	version: number,
	fingerprint: string,
): FailureCause | undefined {
	if (served === undefined || served.kind !== kind) {
		return { kind: "waiting", error: new ChordError({ code: "unavailable", message: `${name} is not served here` }) };
	}
	const { contract } = served;
	if (binds(served.provider, version, fingerprint)) return undefined;
	const message = `${name} v${version} does not match the served v${contract.version}`;
	return { kind: "waiting", error: new ChordError({ code: "contract_mismatch", message }) };
}

/**
 * Waits until `usable()` (a registry value's check, which records its last error) holds, checked at every change the
 * value tells its waiters of (after the batch that made it); rejects when `context` aborts or the value closes. It
 * waits on the value only while it runs.
 */
async function untilUsable(value: RegistryValueSource, usable: () => boolean, context: Context): Promise<void> {
	let changed = Promise.withResolvers<void>();
	const release = value.wait({
		dependencyMoved: () => queueMicrotask(() => changed.resolve()),
		// The value closed with its host: the wait ends with the close's error.
		closed: (error) => changed.reject(error),
	});
	try {
		while (!usable()) {
			await awaitWithContext(changed.promise, context);
			changed = Promise.withResolvers<void>();
		}
	} finally {
		release();
	}
}

/** What the report calls a fate. */
const STARTED = { swap: "swapped", restart: "restarted", retry: "retried" } as const;

/** The `aborted` error of a reload whose context aborted before its commit: nothing changed. */
function reloadAborted(): ChordError {
	return new ChordError({ code: "aborted", message: "reload: aborted" });
}

/** The error of a plugin name given twice: the second is refused. */
function loadedTwice(name: string): Error {
	return new Error(`plugin "${name}" is loaded twice`);
}

/** Whether registry provider `served` serves readers of `version`: its own, or an older one its `accepts` maps back. */
function registryServes(served: StagedRegistry, version: number): boolean {
	const provided = served.registry.version;
	return provided === version || (provided > version && served.provider.accepts?.[version]?.value !== undefined);
}
