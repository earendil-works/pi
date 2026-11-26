// Attempts (§6, §13, §14, §15): one activation of an object, a fresh instance each time. It is the `self` its factory
// declares with (handles to the object's documents and jobs, under its seal token); it runs the activation steps,
// each failing with its own kind; it takes the live object's calls and starts its routines and jobs; and it ends with
// its seal (slice 6a §1.3), the drain and the closes of its natives. A reload's restart drains it (decision "Reload
// restarts every affected object; old work finishes on old code"): its routines stop, it serves old work under its
// own contract, and it is sealed once that work settled. An attempt of an admitted type first runs its admission
// (`admission.ts`): it parks on the decision as on a dependency, hands its factory the admitted value, and follows
// the decision until its seal.

import type { TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { awaitWithContext, type Context, withAbortSignal, withContextValue, withTelemetry } from "../context/index.ts";
import type {
	AdmittedOf,
	Contract,
	EventSource,
	Implementation,
	NamedQuery,
	ParamsOf,
	Schema,
} from "../contracts/index.ts";
import { contractData, currentVersion, NO_GRANTS, type ShapeOf, versionAt } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal } from "../data/index.ts";
import { asChordError, checkArgs, checkParams, invalid, openFailure, stackless, type Value } from "../data/internal.ts";
import type { HandleOf, JsonObject, KeyedBy, StateDefinition, Tx } from "../documents/index.ts";
import {
	type AnyDefinition,
	type KeyDeclarer,
	type KeyedSlot,
	type KeySource,
	SealToken,
} from "../documents/internal.ts";
import type { JobDefinition, JobHandle, JobImplementation } from "../jobs/index.ts";
import { type AnyJobImplementation, type CutReason, Job } from "../jobs/internal.ts";
import type { JsonValue } from "../json.ts";
import { appended, NO_ITEMS } from "../lists.ts";
import type { Contribution, Registry, RegistryValue } from "../registries/index.ts";
import type { RegistryContribution, RegistryWaiter } from "../registries/internal.ts";
import type { Writable } from "../state/index.ts";
import { type Dependent, Derive, type DeriveSource, WritableSource } from "../state/internal.ts";
import { checkExposedOnce } from "../store/column-set.ts";
import type { Columns, RowOf } from "../store/columns.ts";
import { checkLiveQuery, LiveQuery, type LiveTarget } from "../store/live-query.ts";
import type { Query } from "../store/query.ts";
import type { Order } from "../store/sql.ts";
import { tableSqlName } from "../store/sql.ts";
import type { ChordStore } from "../store/store.ts";
import type { TableDefinition } from "../store/table.ts";
import { type Table, TableHandle } from "../store/table-handle.ts";
import { prepareTables } from "../store/table-migration.ts";
import { capped, MAX_MESSAGE, OpenSpan, spanFailed, untraced } from "../telemetry.ts";
import type { NativeWatchable, Watchable, WatchEnd } from "../watch.ts";
import { AdaptedMembers } from "./adapted.ts";
import { type AdmittedValue, type Allowed, Decision, refuseAdmittedJob, type Verdict } from "./admission.ts";
import { CallContext, type Caller, type Ctx, withLinkedAbortSignal } from "./ctx.ts";
import { Deadline } from "./deadline.ts";
import { checkDependencies, type Dependency, ParkedLong, type Parking, parkedCause, pinKeys } from "./dependencies.ts";
import { type EventNode, OwnEventSource, type SourceOwner } from "./events.ts";
import { type FollowAttach, FollowSource } from "./follow.ts";
import type { HostError } from "./host.ts";
import type { ListOptions } from "./list.ts";
import {
	attachDerives,
	checkImplementation,
	contributionOf,
	grantedImplementation,
	type KeyedBinding,
	lacking,
	type Members,
	type Method,
} from "./members.ts";
import { NamedQueryHandle, OwnQuery, type QueriesOptions } from "./named-query.ts";
import {
	type CloseFailed,
	drained,
	type Native,
	type NativeCloseReason,
	NativeHandle,
	type NativeOptions,
	type NativeSlot,
} from "./native.ts";
import type { ChordObject, Served, ServedAdmission } from "./object.ts";
import { OPENING } from "./old-work.ts";
import type { Reader } from "./query-reader.ts";
import {
	firstOf,
	listName,
	listReader,
	liveReader,
	namedBuilders,
	oneSource,
	openReaders,
	type ReaderSite,
	readerSite,
	rowsReader,
	tableExpected,
	undeclaredTable,
} from "./read-declarations.ts";
import type { RefState } from "./ref-state.ts";
import type { Binding, CheckedParams, Reference, RetryWalk } from "./reference.ts";
import { ReexposedEvents } from "./reference-events.ts";
import { type RetrySource, retrySource } from "./retry-on.ts";
import {
	type OnHandler,
	type OnLiveHandler,
	type OnNativeHandler,
	type RoutineDeclarations,
	Routines,
} from "./routines.ts";

/**
 * What a factory declares with. Declarations (`state`, `derive`, `get`, `registry`, `writable`, `events`, `retryOn`,
 * `open`, `on`, `onLive`, `job`; `table`, `query` and `contribute` in `StoreSelf`) are valid only while it runs. `P` is
 * the app's principal type, which the ctx of routine calls and job runs carry.
 */
export interface Self<P extends Principal = Principal> extends RoutineDeclarations<P> {
	/** This object's documents of `definition`, in memory for its life (across its attempts). */
	state<D extends StateDefinition<JsonObject, KeyedBy, false>>(definition: D): HandleOf<D>;
	/**
	 * A value computed from `sources` (JSON watchables and native ones: a `writable`, a registry value, `ref.state`) by
	 * the pure, synchronous `compute`; always JSON.
	 */
	derive<const S extends readonly (Watchable<unknown> | NativeWatchable<unknown>)[], T extends JsonValue>(
		sources: S,
		compute: (
			values: {
				readonly [I in keyof S]: S[I] extends Watchable<infer V>
					? V
					: S[I] extends NativeWatchable<infer V>
						? V
						: never;
			},
		) => T,
	): Watchable<T>;
	/** A reference to another object, live once this object is, released when it ends. */
	get<C extends Contract>(Type: C, params: ParamsOf<C>): Reference<C>;
	/**
	 * Registry `R`'s composed value as this plugin's version of `R` sees it: a declared dependency, as `get` is
	 * (the attempt parks until it has a usable value: `failed { waiting }` while it has none, woken when it has). Read
	 * `.value` at use; once live, a later failure of the registry keeps its last good value while every contribution it
	 * was built from is still in the table.
	 */
	registry<C, V>(R: Registry<C, V>): RegistryValue<V>;
	/**
	 * An in-process value this attempt sets (`set`, identity compared): a contribution, a derive source and an `on`
	 * source, never a state member; its watches end with the attempt, and `set` after its end throws `released`.
	 */
	writable<T>(initial: T): Writable<T>;
	/**
	 * An event source of this attempt (decision "Events: fire-and-forget members"), implementing an event member: `emit`
	 * delivers a JSON value once to each reference bound to the object before it, at the event flush (a microtask), after
	 * the state published before it; never kept, never folded, dropped for a holder that cannot keep up. Emits are no
	 * transaction work (`await self.tx(...)`, then `emit`); after the attempt's seal `emit` throws `released`.
	 */
	events<T>(): EventSource<T>;
	/**
	 * Wake signals: a new value of any of `sources` (registry values; constants never change) retries this object
	 * while it is failed, as `ref.retry()` does, and once more at once if its current activation fails. Followed from
	 * the factory's return until the next attempt's declaration or the object's end; failures wake nothing.
	 */
	retryOn(...sources: readonly (Watchable<unknown> | NativeWatchable<unknown>)[]): void;
	/**
	 * A native, opened during activation after the references are live and the earlier natives are open, and closed
	 * in reverse when the attempt ends. `open` gets a context aborted when the attempt is abandoned; `close` one aborted
	 * at the close timeout. Throw `broken(error)` from `open` when retrying is pointless.
	 */
	open<T>(
		open: (context: Context) => Promise<T>,
		close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>,
		options?: NativeOptions,
	): Native<T>;
	/** Runs `fn` as one transaction of this object (§9). */
	tx<R>(fn: (tx: Tx) => R | Promise<R>, context: Context): Promise<R>;
	/**
	 * A source following another runtime's synchronous observer (Durable's views, slice 6b §3): `attach` runs during
	 * activation once the natives opened (a rejection or `undefined` fails the activation `transient`), and the observer
	 * is detached when the attempt ends. Its runtime failing fails this object `transient`; its `ended` is final, the
	 * source keeping its last value. A state member, a derive source, an `on` source.
	 */
	follow<T>(attach: FollowAttach<T>): Watchable<T>;
	/**
	 * This object's job `definition` (§15), once per job name: `run` runs each started run outside transactions,
	 * `finish` records its outcome in one. Starts are taken once the object is live.
	 */
	job<A, R, S>(definition: JobDefinition<A, R, S>, implementation: JobImplementation<A, R, S, P>): JobHandle<A, R, S>;
	/**
	 * A named query read live (slice 14 §3): the first `range.first` rows of `query` for `args`, and whether a further
	 * row exists, as a JSON watchable. `args` may be a watchable of the arguments: the member shows the previous rows
	 * until the read for the new arguments has run. Opened once this object's dependencies are live; a commit that
	 * can change its rows runs it again in its step. Another object's query is read through its reference
	 * (`self.get(Store, {}).member.name`), the owner's own through what `self.queries` returned.
	 */
	liveQuery<T, A>(
		query: NamedQuery<T, A>,
		args: A | Watchable<A>,
		range: { readonly first: number },
	): Watchable<{ rows: T[]; more: boolean }>;
	/**
	 * The exact number of rows of a named query for `args`, live (slice 14 §3.1). Expensive, know what you are doing:
	 * every run reads every matching row, nothing caps it, and it runs again on every write to its tables except an
	 * `update` that assigns none of its condition's columns. Count what a key or an index bounds.
	 */
	count<T, A>(query: NamedQuery<T, A>, args: A | Watchable<A>): Watchable<number>;
	/**
	 * A list a screen loads more of (slice 14 §4): the rows of a named query in pages of `options.first` between
	 * fixed bookmarks, so loaded rows stay live, `more` sends only the new rows, and a row that moves leaves no gap
	 * and no duplicate. `name` is the list's within this object: its bookmarks survive a reload by it. One source,
	 * `[[namedQuery, args]]`; `args` may be a watchable of the arguments.
	 */
	list<T, A>(
		name: string,
		sources: readonly (readonly [NamedQuery<T, A>, A | Watchable<A>])[],
		options: ListOptions,
	): ListHandle<T>;
}

/** What `self.list` returns: the list's value for a state member, and `more` for a method. */
export type ListHandle<T> = {
	/** The loaded rows in order, and whether rows may follow them. */
	readonly value: Watchable<{ rows: T[]; moreAfter: boolean }>;
	/** Loads one more page behind the last one; resolves once its rows are in `value`. */
	more(context: Context): Promise<null>;
};

/** What a named query's builder returns: a query of the table (`C`, `K`), joined or not. */
export type BuiltQuery<C extends Columns, K extends readonly string[]> = {
	readonly table: TableDefinition<C, K>;
	readonly order: Order;
};

/** A named query's builder: a pure function of the query's arguments. */
export type QueryBuilder<C extends Columns, K extends readonly string[], A> = (args: A) => BuiltQuery<C, K>;

/**
 * The builders `self.queries` takes, by query name: a builder for a query the contract lists (the contract has its
 * argument schema), or `[argsSchema, builder]` for a query private to its owner.
 */
export type QueryBuilders<C extends Columns, K extends readonly string[], A> = {
	readonly [N in keyof A]: QueryBuilder<C, K, A[N]> | readonly [Schema, QueryBuilder<C, K, A[N]>];
};

/**
 * What the factory of a `local` type with empty params declares with: one object per host and type, so its data may
 * persist (P3). `P` as for `Self`.
 */
export interface StoreSelf<P extends Principal = Principal> extends Self<P> {
	/** This object's documents of `definition`: in memory for its life, or persisted in the host's store. */
	state<D extends StateDefinition<JsonObject, KeyedBy, boolean>>(definition: D): HandleOf<D>;
	/** This object's table `definition` in the host's store, once per table name. */
	table<C extends Columns, K extends readonly string[]>(definition: TableDefinition<C, K>): Table<C, K>;
	/**
	 * A live query (decision "Live queries over an object's own tables"): the rows of `q` (at most `limit`, in its
	 * order) over `table`, a table this factory declared, as a JSON watchable (a state member, a derive source). Run
	 * before the object goes live, and again in the commit step of every commit of this object that writes `table`
	 * (one query per such commit, bounded by `limit`; not for tables written hundreds of times a second). A limit is
	 * required (`invalid/args`).
	 */
	query<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
		limit: number,
	): Watchable<RowOf<C>[]>;
	/**
	 * Named queries over `table`, a table this factory declared (slice 14 §3.1): one per entry of `builders`, each a
	 * pure function of its arguments returning a query of the table. What it returns implements a `queries` member of
	 * the contract (the queries listed there; the others are private to this object and bring their argument schema).
	 * `options.map` turns a row (and a joined query's partner) into the item readers get, from the columns `reads`
	 * (and `partnerReads`) list: a change of another column is no change of the item.
	 */
	queries<C extends Columns, K extends readonly string[], T, A extends { readonly [query: string]: unknown }>(
		table: Table<C, K>,
		options: QueriesOptions<RowOf<C>, T>,
		builders: QueryBuilders<C, K, A>,
	): { readonly [N in keyof A]: NamedQuery<T, A[N]> };
	/**
	 * Contributes `value` to registry `R` from the moment this object is live until it ends, fails or restarts (R21: a
	 * host-lifetime object): a plain value, or a Chord watchable of one (followed: its change recomposes). At most one
	 * per registry.
	 */
	contribute<C>(R: Registry<C, unknown>, value: Contribution<C>): void;
}

/** A key of a keyed member pinned on one instance, loaded: its source (mapped when older), and the release (once). */
export type PinnedKey = { readonly source: DeriveSource; readonly release: () => void };

/**
 * A factory: synchronous and declarative, run once per attempt. A remote one also gets the principal in its object's
 * identity and returns every member, its grantable state and event members as builders (slice 15 §1.3); one of a
 * contract served with `admit` (it declares an `admission`, grantable members or flags) gets the admitted value after
 * the principal, `granted` among it (slice 14 §2.1; `self.job` is refused there). Methods get a `Ctx` for the app's
 * principal type `P`.
 */
export type Factory<C extends Contract, P extends Principal = Principal> = ShapeOf<C>["kind"] extends "local"
	? (params: ParamsOf<C>, self: keyof ParamsOf<C> extends never ? StoreSelf<P> : Self<P>) => Implementation<C, Ctx<P>>
	: [AdmittedOf<C>] extends [never]
		? (params: ParamsOf<C>, principal: P, self: Self<P>) => Implementation<C, Ctx<P>>
		: (params: ParamsOf<C>, principal: P, admitted: AdmittedOf<C>, self: Self<P>) => Implementation<C, Ctx<P>>;

/** A parked attempt whose check found nothing to wait for: the shared answer. */
const READY: Parking = { kind: "ready" };

/** Running work of one kind (calls, routine calls, job invocations), with the bookkeeping each runs once. */
type Work = Map<Promise<unknown>, (() => void) | undefined>;

/** Its routines once started: aborted when they stop (its seal, a reload's handover or restart), and their running calls. */
type RoutineRun = { readonly abort: AbortController; readonly calls: Work };

/**
 * What a reload did to an attempt: `started` (a reload started it), `callsDrained` (a restart drains its calls: old
 * work runs on it until its seal, and its end's drain does not wait for them again), `routinesStopped` (its routines
 * stopped, and do not start late).
 */
type Reloaded = { started: boolean; callsDrained: boolean; routinesStopped: boolean };

/** A first dependency check that did not park: the shared answer. */
const NOT_PARKED = { done: true, cause: undefined } as const;

/** No documents declared: the shared empty map. */
const NO_DOCUMENTS: ReadonlyMap<string, AnyDefinition> = new Map();

/** No running work: the shared empty map. */
const NO_WORK: ReadonlyMap<Promise<unknown>, (() => void) | undefined> = new Map();

/** Runs the bookkeeping of the work still in `work` (stuck past the drain) and forgets it. */
function cleanUp(work: Work | undefined): void {
	if (work === undefined) return;
	for (const [running, cleanup] of work) {
		work.delete(running);
		cleanup?.();
	}
}

/** An attempt's registry reads, contributions and wake signals, and its writables (slice 8). */
type RegistryDeclarations = {
	/** Releases its registry reads (with its references): a read keeps an older version's mapping. */
	readonly reads: (() => void)[];
	/** Its wake signals (`self.retryOn`), handed to its object right after the factory. */
	readonly retrySources: RetrySource[];
	/** Its writables, whose watches end with it. */
	readonly writables: { detach(error: Error): void }[];
	/** Its contributions as declared, resolved during activation into `contributions`. */
	readonly declared: { readonly registry: Registry<unknown, unknown>; readonly value: unknown }[];
	contributions: readonly RegistryContribution[];
};

/** How an attempt's activation ended. */
type Activation =
	| { readonly kind: "live" }
	| { readonly kind: "failed"; readonly cause: FailureCause }
	| { readonly kind: "ended"; readonly error: ChordError };

/** How an activation that did not go live ended. */
type NotLive = Exclude<Activation, { readonly kind: "live" }>;

/** What an attempt's activation span links to (its object's first trigger, or its last attempt's span) and its number. */
export type AttemptTrace = { readonly trigger: TelemetryContext; readonly attempt: number };

/**
 * How an attempt's activation ended, for its span: live, failed (a transient failure's next attempt at `retryAt`), or
 * ended (abandoned, its object gone).
 */
export type Activated =
	| { readonly kind: "live" }
	| { readonly kind: "failed"; readonly cause: FailureCause; readonly retryAt: number | undefined }
	| { readonly kind: "ended" };

/** The error of an object, or a getter, that waited `ms` without the object going live. */
export function notLive(label: string, ms: number): ChordError {
	return new ChordError({ code: "unavailable", message: `${label}: did not become live within ${ms} ms` });
}

/**
 * What an attempt has only for features few objects use (reloads, routines, jobs, tables, lists, registries, its own
 * events), made by the first of them: a field each cost every attempt 8 B for as long as its object lives.
 */
type AttemptExtras = {
	/** Its shared mappings for the consumers of older versions (Q10), by version; made by the first. */
	adapted: Map<number, AdaptedMembers> | undefined;
	/** Its routines once they started. */
	routineRun: RoutineRun | undefined;
	/** Its routines as declared, made by the first. */
	routines: Routines | undefined;
	/** Its jobs by name, made by the first. */
	jobs: Map<string, Job> | undefined;
	/** The tables it declared, by name; made by the first. */
	tables: Map<string, TableHandle> | undefined;
	/** The names of the lists its factory declared: one list per name. Made by the first. */
	listed: Set<string> | undefined;
	/**
	 * Its running job invocations, as `#running`: the drain at its end waits for them (a restart's drain does not: they
	 * are cut at its seal). Made by the first.
	 */
	runs: Work | undefined;
	/** A followed source's end while this attempt activated: it fails as it goes live (if its activation returned). */
	endedEarly: ChordError | undefined;
	/** Its registry reads, contributions, wake signals and writables, made by the first. */
	registryDeclarations: RegistryDeclarations | undefined;
	/** What its own event sources check (its seal) and count with, made by the first `self.events()`. */
	sourceOwner: SourceOwner | undefined;
	/** Its own event sources, detached at its end; made by the first. */
	sources: readonly OwnEventSource[] | undefined;
	/** What a reload did to it, made by the first such step. */
	reloaded: Reloaded | undefined;
};

/**
 * One attempt of an object. Activation: factory, documents hydrated (the object's slots), tables prepared and live
 * queries run, references bound, then parked until every dependency is live (no timer: the deadline paused), then its
 * own steps: natives opened one after another, followed sources attached, members checked, derives computed; bounded
 * by the host's `readyTimeout`. Ending: sealed at once (calls aborted, its transactions refused and the one holding the
 * line discarded, its job invocations cut off), then the drain, the closes in reverse, derives and live queries
 * detached; its object releases its references. Documents and job runs stay on the object.
 */
export class Attempt implements StoreSelf, KeyDeclarer, RegistryWaiter {
	readonly #object: ChordObject;
	/** The type its object was served as when it was made: its provider's `accepts` map its older consumers. */
	readonly #served: Served;
	/** What it has only for features few objects use (`AttemptExtras`), made by the first of them. */
	#extras: AttemptExtras | undefined;
	/** The object's context: the natives' closes run under it. */
	readonly #context: Context;
	/** Aborted when the attempt is abandoned or ends: openers, activation's waits and calls run under its signal. */
	readonly #abort = new AbortController();
	/** The object's context under this attempt's signal, and its activation span while one is recorded. */
	#opening: Context;
	readonly #trace: AttemptTrace;
	/** Its activation span while it runs (none when the host records nothing); a parked attempt resumes in a new one. */
	#activation: OpenSpan<"chord.activate"> | undefined;
	/** When it parked (`performance.now()`), while it is parked: `chord.park.duration` once it leaves. */
	#parkedAt: number | undefined;
	/** The seal token its handles and transactions carry (the seal fence). */
	readonly #token = new SealToken();
	/** The documents it declared, by name: "declared twice" is per attempt. Made by the first: most attempts have none. */
	#declared: Map<string, AnyDefinition> | undefined;
	/** Its factory's `at(key)` pins: the object holds them from its factory's return to the next one's (rule 6). */
	#pins: readonly (() => void)[] = NO_ITEMS;
	#declaring = false;
	/** Set once it went live: its derives' failures are reported from then on (`derive_failed`). */
	#isLive = false;
	/** The checked implementation, once activation checked it. */
	#members: Members | undefined;
	#derives: readonly Derive[] = NO_ITEMS;
	/** Its followed sources, attached in declaration order after the natives. */
	#follows: readonly FollowSource[] = NO_ITEMS;
	/** Its own live queries with what each reads, run at activation (after the tables are prepared), detached at its end. */
	#queries: readonly { readonly live: LiveQuery; readonly target: LiveTarget }[] = NO_ITEMS;
	/** Its readers of named queries (`self.liveQuery`, `self.count`), opened once its dependencies are live. */
	#readers: readonly Reader[] = NO_ITEMS;
	/** References this attempt declared with `self.get` (params checked), bound during activation. */
	#references: readonly {
		readonly binding: Binding;
		readonly contract: Contract;
		readonly params: CheckedParams;
	}[] = NO_ITEMS;
	/**
	 * Its dependencies (`self.get` references and `self.registry` values) in declaration order: the parked cause and
	 * `parked_long` name the first that blocks. Made by the first; let go after the dependency check (a live attempt
	 * keeps none).
	 */
	#dependencies: readonly Dependency[] | undefined;
	#natives: readonly NativeSlot[] = NO_ITEMS;
	/**
	 * Running calls' handlers, routine calls and job runs, each with its bookkeeping (call counts, `ctx.get`
	 * references): an ending attempt waits for them (the drain); the bookkeeping runs once, when its work settles or at
	 * teardown for work stuck past the drain (decision "The seal fence" (4)). One map and one reaction per piece of work:
	 * the call path costs no more than before the cleanups. Made by the first: an object nobody calls keeps none.
	 */
	#running: Work | undefined;
	/** What activation returns once the attempt was abandoned: a timeout, a cycle through its object, or its end. */
	#abandoned: NotLive | undefined;
	/** Its dependencies while it is parked on them (the dependency check); `undefined` otherwise. */
	#parked: readonly Dependency[] | undefined;
	/** A dependency changed since the last check: the parked attempt checks again (one check per batch of changes). */
	#moved = false;
	/** What a parked attempt waiting for a change waits on; resolved after the change's batch. */
	#changed: PromiseWithResolvers<void> | undefined;
	/**
	 * Its first dependency check, for a reload (its report, its predecessor's references): waited for by someone, or
	 * done with why it parked (`undefined`: it did not). Made by the first who asks or by the check.
	 */
	#check:
		| { readonly done: false; readonly waiting: PromiseWithResolvers<FailureCause | undefined> }
		| { readonly done: true; readonly cause: FailureCause | undefined }
		| undefined;
	/** An admitted type's decision, from its `admit` until its object releases it (`releaseAdmission`). */
	#decision: Decision | undefined;
	/** What its decision allowed, from its first allow on: its factory's value. */
	#admitted: Allowed | undefined;
	/** What its object was last told of its decision, from the allow on: the same object means nothing changed. */
	#followed: Verdict | undefined;

	constructor(object: ChordObject, context: Context, trace: AttemptTrace) {
		this.#object = object;
		this.#served = object.served;
		this.#context = context;
		// Its opener's calls are known as its object's: their gate waits are the object's edges for reload cycles.
		this.#opening = withContextValue(OPENING, object, withAbortSignal(this.#abort.signal, context));
		this.#trace = trace;
	}

	state<D extends StateDefinition<JsonObject, KeyedBy, boolean>>(definition: D): HandleOf<D> {
		this.#assertDeclaring("state");
		const what = `state "${definition.name}"`;
		this.#declared ??= new Map();
		if (this.#declared.has(definition.name)) throw new Error(`${this.#object.label}: ${what} is declared twice`);
		if (definition.persist) {
			this.#assertPersistable(what);
			this.#object.claimDocuments("chord");
		}
		this.#declared.set(definition.name, definition);
		return this.#object.documents.declare(definition, this.#token, this);
	}

	/** `handle.at(key)`: pins `key` of `slot` while this attempt's factory's pins are held, and returns its source. */
	at(slot: KeyedSlot, key: string): KeySource {
		this.#assertDeclaring("state(...).at");
		this.#pins = appended(this.#pins, slot.pin(key, this.#opening));
		return slot.source(key);
	}

	table<C extends Columns, K extends readonly string[]>(definition: TableDefinition<C, K>): Table<C, K> {
		this.#assertDeclaring("table");
		const object = this.#object;
		const { served, label } = object;
		const store = this.#assertPersistable(`table "${definition.name}"`);
		this.#more().tables ??= new Map();
		if (this.#extras!.tables!.has(definition.name))
			throw new Error(`${label}: table "${definition.name}" is declared twice`);
		checkExposedOnce(
			definition,
			[...this.#extras!.tables!.values()].map((declared) => declared.definition),
			label,
		);
		const sqlName = tableSqlName(served.contract.name, definition.name);
		object.claimTable(sqlName);
		const owner = {
			label,
			scope: object.documents,
			assertLive: () => object.documents.assertLive(),
			fail: (error: ChordError) => object.failLive(this, { kind: "broken", error }),
		};
		// The handle's rows are the definition's, typed by `C` and `K`.
		const handle = new TableHandle(definition as unknown as TableDefinition, sqlName, store, owner);
		this.#extras!.tables!.set(definition.name, handle);
		return handle as unknown as Table<C, K>;
	}

	query<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
		limit: number,
	): Watchable<RowOf<C>[]> {
		this.#assertDeclaring("query");
		const { host, label } = this.#object;
		// Plugin code may pass any table: only a handle this attempt declared is taken (its object's own table).
		const handle: unknown = table;
		if (handle instanceof NamedQueryHandle) throw tableExpected(label);
		if (!(handle instanceof TableHandle) || this.#extras?.tables?.get(handle.definition.name) !== handle) {
			throw undeclaredTable(label, "query");
		}
		checkLiveQuery(handle.definition, q as unknown as Query, limit, label);
		const owner = {
			label,
			report: (error: unknown) =>
				host.report({ kind: "query_failed", object: label, query: handle.definition.name, error }),
		};
		const { rows } = handle.definition;
		// The owner's window: its value the rows themselves.
		const live = new LiveQuery({ store: handle.store, batch: host.batch }, owner, {
			kind: "rows",
			// Checked above: a positive integer.
			range: { limit: limit as number },
			present: (items) => items,
		});
		const target: LiveTarget = {
			// The query is of `handle`'s table (checked above); every column of the row is read.
			spec: { query: q as unknown as Query, table: handle.sql.table, projection: {}, owner: handle },
			// The owner's own window: nobody shares it.
			sharing: undefined,
			// A table's rows hold its columns' values: scalars and JSON.
			decode: (stored, context) => rows.decode(stored, context) as JsonValue,
		};
		this.#queries = appended(this.#queries, { live, target });
		// Its rows are the table's, typed by `C`.
		return live as unknown as Watchable<RowOf<C>[]>;
	}

	queries<C extends Columns, K extends readonly string[], T, A extends { readonly [query: string]: unknown }>(
		table: Table<C, K>,
		options: QueriesOptions<RowOf<C>, T>,
		builders: QueryBuilders<C, K, A>,
	): { readonly [N in keyof A]: NamedQuery<T, A[N]> } {
		this.#assertDeclaring("queries");
		const { label } = this.#object;
		// Plugin code may pass any table: only a handle this attempt declared is taken (its object's own table).
		const handle: unknown = table;
		if (!(handle instanceof TableHandle) || this.#extras?.tables?.get(handle.definition.name) !== handle) {
			throw undeclaredTable(label, "queries");
		}
		// The mapping is the plugin's, typed by the table's rows; Chord hands it decoded rows.
		const mapped = options as QueriesOptions<unknown, unknown>;
		const named = namedBuilders(label, builders).map(
			({ name, builder, args }) => [name, new OwnQuery(label, name, handle, builder, mapped, args)] as const,
		);
		// One named query per builder, typed by the mapping's items and the builders' arguments.
		return Object.fromEntries(named) as unknown as { readonly [N in keyof A]: NamedQuery<T, A[N]> };
	}

	liveQuery<T, A>(
		query: NamedQuery<T, A>,
		args: A | Watchable<A>,
		range: { readonly first: number },
	): Watchable<{ rows: T[]; more: boolean }> {
		this.#assertDeclaring("liveQuery");
		const { reader, source } = rowsReader(this.#readerSite(), query, args, range);
		this.#readers = appended(this.#readers, reader);
		// Its value is what `present` builds from the query's items.
		return source as unknown as Watchable<{ rows: T[]; more: boolean }>;
	}

	count<T, A>(query: NamedQuery<T, A>, args: A | Watchable<A>): Watchable<number> {
		this.#assertDeclaring("count");
		const { reader, source } = liveReader(this.#readerSite(), "count", query, args, { kind: "count" });
		this.#readers = appended(this.#readers, reader);
		// A count's value is its number.
		return source as unknown as Watchable<number>;
	}

	list<T, A>(
		name: string,
		sources: readonly (readonly [NamedQuery<T, A>, A | Watchable<A>])[],
		options: ListOptions,
	): ListHandle<T> {
		this.#assertDeclaring("list");
		const at = this.#readerSite();
		const first = firstOf(at.label, "list", options);
		const source = oneSource(at.label, sources);
		// Checked last: a list refused for another reason does not take its name.
		this.#more().listed ??= new Set();
		const listed = listName(at.label, name, this.#extras!.listed!);
		const { reader, list } = listReader(at, listed, source, first, this.#object.listMemory(listed));
		this.#readers = appended(this.#readers, reader);
		// Its value is `{ rows, moreAfter }` of the query's items.
		return { value: list as unknown as Watchable<{ rows: T[]; moreAfter: boolean }>, more: (ctx) => list.more(ctx) };
	}

	/** Where this attempt's readers live. */
	#readerSite(): ReaderSite {
		const { host, label } = this.#object;
		return readerSite(host, label, () => this.dependencyMoved());
	}

	derive<const S extends readonly (Watchable<unknown> | NativeWatchable<unknown>)[], T extends JsonValue>(
		sources: S,
		compute: (
			values: {
				readonly [I in keyof S]: S[I] extends Watchable<infer V>
					? V
					: S[I] extends NativeWatchable<infer V>
						? V
						: never;
			},
		) => T,
	): Watchable<T> {
		this.#assertDeclaring("derive");
		// The values are the sources' values, in order; the result is `T`.
		const derive = new Derive(sources, compute as (values: readonly unknown[]) => T, this.#object.host.batch);
		this.#derives = appended(this.#derives, derive);
		return derive as unknown as Watchable<T>;
	}

	get<C extends Contract>(Type: C, params: ParamsOf<C>): Reference<C> {
		this.#assertDeclaring("get");
		const { host } = this.#object;
		const checked = checkParams(Type, params, this.#opening);
		const binding = host.reference(Type, this.#object, this.#caller(), {});
		this.#references = appended(this.#references, { binding, contract: Type, params: checked });
		this.#dependencies = appended(this.#dependencies ?? NO_ITEMS, { kind: "reference", binding });
		// The binding was built from `Type`'s members.
		return binding.reference as Reference<C>;
	}

	registry<C, V>(R: Registry<C, V>): RegistryValue<V> {
		this.#assertDeclaring("registry");
		const value = this.#object.host.registryRecord(R.name).value(R.version);
		this.#dependencies = appended(this.#dependencies ?? NO_ITEMS, { kind: "registry", value });
		// Its values are the composition as `R`'s version has it, `V`.
		return value as RegistryValue<V>;
	}

	writable<T>(initial: T): Writable<T> {
		this.#assertDeclaring("writable");
		const owner = {
			context: this.#context,
			assertUsable: () => {
				if (this.#token.sealed) throw this.#object.ended();
			},
		};
		const writable = new WritableSource(initial, owner, this.#object.host.batch);
		this.#declarations().writables.push(writable);
		return writable;
	}

	events<T>(): EventSource<T> {
		this.#assertDeclaring("events");
		const object = this.#object;
		this.#more().sourceOwner ??= {
			events: object.host.events,
			sealed: () => (this.#token.sealed ? object.ended() : undefined),
		};
		const source = new OwnEventSource(this.#extras!.sourceOwner!);
		this.#extras!.sources = appended(this.#extras!.sources ?? NO_ITEMS, source);
		// Its values are `T`: JSON the object emits, never validated (as state).
		return source as unknown as EventSource<T>;
	}

	retryOn(...sources: readonly (Watchable<unknown> | NativeWatchable<unknown>)[]): void {
		this.#assertDeclaring("retryOn");
		const { retrySources } = this.#declarations();
		for (const source of sources) retrySources.push(retrySource(source, this.#object.label));
	}

	contribute<C>(R: Registry<C, unknown>, value: Contribution<C>): void {
		this.#assertDeclaring("contribute");
		const { served, label } = this.#object;
		// R21: the types allow it only to host-lifetime objects; plugin code is bundled without type checks.
		if (served.kind !== "local" || !served.hostLifetime) {
			throw new Error(`${label}: self.contribute is valid only in a local type with empty params`);
		}
		const { declared } = this.#declarations();
		if (declared.some(({ registry }) => registry.name === R.name)) {
			throw new Error(`${label}: registry ${R.name} is contributed to twice`);
		}
		declared.push({ registry: R as Registry<unknown, unknown>, value });
	}

	open<T>(
		open: (context: Context) => Promise<T>,
		close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>,
		options: NativeOptions = {},
	): Native<T> {
		this.#assertDeclaring("open");
		const { host, label } = this.#object;
		const closeTimeout = options.closeTimeout ?? host.timeouts.close;
		const owner = {
			object: label,
			type: this.#object.served.contract.name,
			position: this.#natives.length + 1,
			context: this.#context,
			telemetry: host.telemetry,
			host: host.spanHost,
			report: (error: HostError) => host.report(error),
		};
		const native = new NativeHandle(open, close, closeTimeout, owner);
		this.#natives = appended(this.#natives, native);
		return native;
	}

	tx<R>(fn: (tx: Tx) => R | Promise<R>, context: Context): Promise<R> {
		return this.#object.documents.tx(fn, this.#token, context);
	}

	follow<T>(attach: FollowAttach<T>): Watchable<T> {
		this.#assertDeclaring("follow");
		const object = this.#object;
		const owner = { label: object.label, context: this.#context, ended: (end: WatchEnd) => this.#followEnded(end) };
		// The source holds what the runtime gives it, `T`, as Chord's JSON sources do.
		const source = new FollowSource(attach as unknown as FollowAttach<JsonValue>, owner, object.host.batch);
		this.#follows = appended(this.#follows, source);
		return source as unknown as Watchable<T>;
	}

	on<T>(source: Watchable<T>, fn: OnHandler<T>): void;
	on<T>(source: NativeWatchable<T>, fn: OnNativeHandler<T>): void;
	on(source: Watchable<unknown> | NativeWatchable<unknown>, fn: (...args: never[]) => void | Promise<void>): void {
		this.#assertDeclaring("on");
		this.#more().routines ??= new Routines();
		this.#extras!.routines!.on(source, fn);
	}

	onLive(fn: OnLiveHandler): void {
		this.#assertDeclaring("onLive");
		this.#more().routines ??= new Routines();
		this.#extras!.routines!.onLive(fn);
	}

	job<A, R, S>(definition: JobDefinition<A, R, S>, implementation: JobImplementation<A, R, S>): JobHandle<A, R, S> {
		this.#assertDeclaring("job");
		const object = this.#object;
		refuseAdmittedJob(this.#served, object.label);
		this.#more().jobs ??= new Map();
		if (this.#extras!.jobs!.has(definition.name)) {
			throw new Error(`${object.label}: job "${definition.name}" is declared twice`);
		}
		if (definition.persist !== undefined) {
			this.#assertPersistable(`job "${definition.name}"`);
			object.claimDocuments("chord.jobs");
			object.claimDocuments("chord.job-states");
		}
		const owner = {
			host: object.host,
			caller: this.#caller(),
			context: this.#context,
			signal: this.#abort.signal,
			token: this.#token,
			documents: object.documents,
			admit: (running: Promise<unknown>, cleanup?: () => void) => {
				this.#running ??= new Map();
				this.#admit(this.#running, running, cleanup);
			},
			admitRun: (running: Promise<unknown>, cleanup: () => void) => {
				this.#more().runs ??= new Map();
				this.#admit(this.#extras!.runs!, running, cleanup);
			},
		};
		// The job keeps its runs as JSON and calls the implementation with them; the handle types them again.
		const records = object.jobRecords(definition as JobDefinition<unknown, unknown, unknown>);
		const job = new Job(records, implementation as unknown as AnyJobImplementation, owner);
		this.#extras!.jobs!.set(definition.name, job);
		return job as unknown as JobHandle<A, R, S>;
	}

	/**
	 * Activates once `ending` (the previous instance's) has finished; `readyTimeout` bounds both (an attempt abandoned
	 * while it waits has opened nothing). An admitted type's admission runs before that wait (slice 14 §2.2): only its
	 * factory waits for the previous instance's teardown.
	 */
	async activate(ending: Promise<void> | undefined): Promise<Activation> {
		this.#startActivation(this.#trace.trigger);
		const { ready } = this.#object.host.timeouts;
		const deadline = new Deadline(ready, () => {
			this.abandon({ kind: "failed", cause: { kind: "transient", error: notLive(this.#object.label, ready) } });
		});
		try {
			const served = this.#served;
			if (served.kind === "remote" && served.admission !== undefined) {
				const refused = await this.#runAdmission(served.admission, deadline);
				if (refused !== undefined) return refused;
				this.#activation?.span.addEvent("chord.admit", { outcome: "allow" });
			}
			if (ending !== undefined) {
				try {
					await awaitWithContext(ending, this.#opening);
				} catch {
					// An ending never rejects: only an abandonment (the deadline) ends this wait early.
					return this.#abandoned!;
				}
			}
			return await this.#activate(deadline);
		} finally {
			deadline.clear();
			// Ended before its first dependency check (its factory threw, it was abandoned): nothing parked.
			this.#settleCheck(undefined);
		}
	}

	/**
	 * The admission phase (slice 14 §2.2): one microtask after its start (a seal's flush has ended by then), `admit`
	 * declares against this attempt's decision, whose requests are bound at once (its object then lets its
	 * predecessors' go). The attempt parks on them, and on a denial showing `failed { denied }`, with no timer, and goes
	 * on with the first allow. Resolves `undefined` once allowed, else with how the attempt ends.
	 */
	async #runAdmission(admission: ServedAdmission, deadline: Deadline): Promise<NotLive | undefined> {
		await undefined;
		if (this.#abandoned !== undefined) return this.#abandoned;
		const object = this.#object;
		const decision = new Decision({
			host: object.host,
			label: object.label,
			caller: this.#caller(),
			dependent: object,
			grants: currentVersion(this.#served.contract).grants,
			moved: () => this.#admissionMoved(),
		});
		try {
			// A remote object's identity has its principal.
			decision.declare((self) => admission.admit(object.params, object.principal!, self), this.#opening);
		} catch (error) {
			decision.release();
			return this.#broken(error);
		}
		this.#decision = decision;
		object.admitting(this);
		return this.#park(decision.dependencies, (long) => this.#decide(decision, long), deadline);
	}

	/** One check of its admission while it parks on it: allowed, it goes on; denied, it shows `failed { denied }`. */
	async #decide(decision: Decision, long: ParkedLong): Promise<Parking> {
		this.#admitted = undefined;
		const verdict: Verdict = await decision.settle(long, this.#opening);
		if (verdict.kind === "allow") {
			this.#admitted = verdict;
			this.#followed = verdict;
			return READY;
		}
		if (verdict.kind !== "deny") return verdict;
		const cause: FailureCause = { kind: "denied", error: verdict.error };
		const activation = this.#activation;
		if (activation !== undefined && !activation.ended) activation.span.addEvent("chord.admit", { outcome: "deny" });
		return { kind: "parked", shown: { kind: "failed", cause, retryAt: undefined }, firstPass: true, cause };
	}

	/**
	 * Something its admission reads changed. While it still decides, its parked check runs again. From its allow on it
	 * follows the decision (slice 14 §2.2, "Watch"), live, opening its natives or draining for a reload alike: an equal
	 * decision changes nothing; anything else (another value, a denial, a source that failed or ended) is its object's
	 * to act on, which seals it at once and admits afresh. It goes on following after its own failure, so its failed
	 * object still shows a denial; a later attempt's admission takes over once it bound.
	 */
	#admissionMoved(): void {
		if (this.#admitted === undefined) {
			this.dependencyMoved();
			return;
		}
		const verdict = this.#decision!.now(this.#opening);
		if (verdict === this.#followed) return;
		this.#followed = verdict;
		this.#object.readmit(this, verdict);
	}

	/** What its admission allowed (its factory's value); `undefined` before its first allow and without an admission. */
	get admitted(): Allowed | undefined {
		return this.#admitted;
	}

	/** Whether it was sealed: its object lets a sealed attempt's admission go once a later one bound its requests. */
	get sealed(): boolean {
		return this.#token.sealed;
	}

	/** Releases what its admission declared (its references, registry reads, derives and live queries); once. */
	releaseAdmission(): void {
		this.#decision?.release();
	}

	/** Its current (or last) activation span; `undefined` when the host records nothing. */
	get activationSpan(): TelemetrySpan | undefined {
		return this.#activation?.span;
	}

	/**
	 * Its activation's outcome, as its object took it: its span ends with it (a failure's error and a transient one's
	 * backoff an event). An attempt still parked (its span ended `parked`) that fails or ends there records it in a short
	 * span linked to the parked one, as its resumed steps would run in one (review L4).
	 */
	activated(outcome: Activated): void {
		const current = this.#activation;
		if (current === undefined) return;
		if (current.ended) {
			if (outcome.kind === "live") return;
			this.#startActivation(current.span);
		}
		const activation = this.#activation!;
		const { span } = activation;
		if (outcome.kind === "failed") {
			spanFailed(span, "activation_failed", outcome.cause.error);
			if (outcome.retryAt !== undefined)
				span.addEvent("chord.retry", { backoff: Math.max(0, outcome.retryAt - Date.now()) });
		}
		span.setAttributes({ outcome: outcome.kind });
		activation.end();
	}

	/**
	 * Starts an activation span on the host's adapter linked to `link` (none when it records nothing); the activation's
	 * steps (its natives' opens, its references' holds) run under it.
	 */
	#startActivation(link: TelemetryContext): void {
		const { host, served, label } = this.#object;
		if (untraced(host.telemetry)) return;
		const attributes = {
			"chord.host": host.spanHost,
			type: served.contract.name,
			object: capped(label),
			attempt: this.#trace.attempt,
		};
		const activation = new OpenSpan(host.telemetry, "chord.activate", attributes);
		if (!untraced(link)) activation.span.addLink({ context: link });
		this.#activation = activation;
		this.#opening = withTelemetry(activation.span, this.#opening);
	}

	/** It parked showing `shown`: its activation span ends `parked` with the cause as an event. */
	#parkedOn(shown: RefState): void {
		this.#parkedAt ??= performance.now();
		const activation = this.#activation;
		if (activation === undefined || activation.ended) return;
		const cause = shown.kind === "failed" ? shown.cause.error.message.slice(0, MAX_MESSAGE) : "loading";
		activation.span.addEvent("chord.park", { cause });
		activation.span.setAttributes({ outcome: "parked" });
		activation.end();
	}

	/** It leaves its parking (its dependencies live, or abandoned): its park's duration is recorded. */
	#parkEnded(): void {
		if (this.#parkedAt === undefined) return;
		this.#object.host.metrics.histogram("chord.park.duration").record(performance.now() - this.#parkedAt);
		this.#parkedAt = undefined;
	}

	/** Abandons the activation with `outcome` (once): its waits stop and the openers' contexts are aborted. */
	abandon(outcome: NotLive): void {
		if (this.#abandoned !== undefined) return;
		this.#abandoned = outcome;
		const reason = outcome.kind === "ended" ? outcome.error : outcome.cause.error;
		this.#abort.abort(reason);
		this.#stopRoutines(reason);
	}

	/**
	 * A followed runtime ended its observer (R4): `failed` fails this attempt `transient`, live or activating; `ended`
	 * does only while it activates (it would go live over a source that ended). An activation that already returned
	 * fails as it goes live.
	 */
	#followEnded(end: WatchEnd): void {
		if (end.kind === "ended" && this.#isLive) return;
		const { label } = this.#object;
		const error =
			end.kind === "failed"
				? asChordError(end.error, label)
				: new ChordError({ code: "unavailable", message: `${label}: a followed source ended while it activated` });
		if (this.#isLive) {
			this.#object.failLive(this, { kind: "transient", error });
			return;
		}
		this.#more().endedEarly ??= error;
		this.abandon({ kind: "failed", cause: { kind: "transient", error } });
	}

	/** The object went live: its jobs take starts and its routines start, in this turn; both stop when it is sealed. */
	live(): void {
		this.#isLive = true;
		const early = this.#extras?.endedEarly;
		if (early !== undefined) {
			this.#object.failLive(this, { kind: "transient", error: early });
			return;
		}
		for (const job of this.#extras?.jobs?.values() ?? NO_ITEMS) job.live();
		const routines = this.#extras?.routines;
		if (routines !== undefined) this.#startRoutines(routines);
	}

	/** Starts its `routines`, unless it was sealed meanwhile. */
	#startRoutines(routines: Routines): void {
		if (this.#abandoned !== undefined || this.#extras?.reloaded?.routinesStopped === true) return;
		const { host, label } = this.#object;
		const run: RoutineRun = { abort: new AbortController(), calls: new Map() };
		this.#more().routineRun = run;
		routines.start({
			label,
			type: this.#object.served.contract.name,
			host,
			caller: this.#caller(),
			context: withAbortSignal(run.abort.signal, this.#context),
			admit: (running, cleanup) => this.#admit(run.calls, running, cleanup),
		});
	}

	/** Its routines stop with `reason` (or may not start any more: `#startRoutines` asks the abandonment too). */
	#stopRoutines(reason: unknown): void {
		this.#extras?.routineRun?.abort.abort(reason);
	}

	/** Its routines stop (their ctx aborted); their running calls are waited for by the drain. */
	stopRoutines(): void {
		this.#reload().routinesStopped = true;
		this.#stopRoutines(stackless({ code: "released", reason: "ended", message: `${this.#object.label}: reloaded` }));
	}

	/**
	 * A restart drains it: from now on it serves old work (calls caused by calls on old attempts, routed by its object)
	 * until its seal, counted as the host's old work.
	 */
	beginDrain(): void {
		this.#reload().callsDrained = true;
		this.#object.host.oldWork.open();
	}

	/** Whether a restart drains it and it is not sealed yet: old work runs on it. */
	get draining(): boolean {
		return this.#extras?.reloaded?.callsDrained === true && this.#abandoned === undefined;
	}

	/**
	 * Waits until no call or routine call runs on it, routed old work included (it joins while the drain runs), or until
	 * `due` (`Date.now()` time; `drain_timeout` reported). Its end's drain then waits for them no more.
	 */
	async drainCalls(due: number): Promise<void> {
		const { host, label } = this.#object;
		for (;;) {
			const calls = [...(this.#running ?? NO_WORK).keys(), ...(this.#extras?.routineRun?.calls ?? NO_WORK).keys()];
			if (calls.length === 0) return;
			const left = due - Date.now();
			if (left <= 0 || (await drained(calls, calls.length, left)) === "timeout") {
				host.report({ kind: "drain_timeout", object: label });
				return;
			}
		}
	}

	/** The type it was made with: its contract and provider (old work and its consumers use it by that contract). */
	get served(): Served {
		return this.#served;
	}

	/** A reload started it: once live, its object retries its blocked job runs (slice 7b §8). */
	startedByReload(): void {
		this.#reload().started = true;
	}

	/** Whether a reload started it. */
	get reloadStarted(): boolean {
		return this.#extras?.reloaded?.started === true;
	}

	/** What a reload did to it, made by the first such step. */
	#reload(): Reloaded {
		const more = this.#more();
		more.reloaded ??= { started: false, callsDrained: false, routinesStopped: false };
		return more.reloaded;
	}

	/** Whether its factory declared job `name`. */
	declaresJob(name: string): boolean {
		return this.#extras?.jobs?.has(name) === true;
	}

	/** Whether its factory opens natives (`self.open`): a restart's contributions then leave at its seal (F-b). */
	get opensNatives(): boolean {
		return this.#natives.length > 0;
	}

	/**
	 * Its first dependency check: why it parked (`parkedCause`), `undefined` when it went on (its dependencies live) or
	 * its activation ended before (its predecessor's references are released once it is done).
	 */
	get checked(): Promise<FailureCause | undefined> {
		const check = this.#check;
		if (check?.done === true) return Promise.resolve(check.cause);
		if (check !== undefined) return check.waiting.promise;
		const waiting = Promise.withResolvers<FailureCause | undefined>();
		this.#check = { done: false, waiting };
		return waiting.promise;
	}

	/** Its first dependency check is done: parked for `cause`, or not (once). */
	#settleCheck(cause: FailureCause | undefined): void {
		const check = this.#check;
		if (check?.done === true) return;
		// Not parked (most attempts): the shared answer, nothing made.
		this.#check = cause === undefined ? NOT_PARKED : { done: true, cause };
		check?.waiting.resolve(cause);
	}

	/** Whether it is parked on its dependencies (the dependency check runs). */
	get isParked(): boolean {
		return this.#parked !== undefined;
	}

	/** Its contributions, resolved by its activation: in the registries' tables while its object is live. */
	get contributions(): readonly RegistryContribution[] {
		return this.#extras?.registryDeclarations?.contributions ?? NO_ITEMS;
	}

	/**
	 * The names its admission granted (slice 15 §1.2): a remote object's grantable members and flags its caller has;
	 * none for a local object and a type without an admission.
	 */
	get granted(): ReadonlySet<string> {
		return this.#admitted?.granted ?? NO_GRANTS;
	}

	/** The state members, as Chord follows them. */
	get stateMembers(): ReadonlyMap<string, DeriveSource> {
		return this.#members!.state;
	}

	/**
	 * Calls a method for `caller`, bound at `version`: a method it lacks fails first, `forbidden` for a grantable one
	 * not granted, `invalid/member` for any other (for an older version after its table's checks), then the arguments
	 * are checked against that version (L1) and, for an older one (Q10), mapped forwards, the handler's result mapped
	 * back, or the provider's replacement of a removed
	 * method run instead; a refused method fails `contract_mismatch`. The handler runs under a ctx aborted by the caller
	 * and by this attempt's end, admitted to the drain before it runs. Either rejects the caller at once; the handler
	 * runs on, its transactions refused, and the drain waits for it. Its `ctx.get` references are released when it
	 * settles. Measured choices (fix round 2): one body for every version (with the shared part in a helper method, a
	 * call over a link was about 10% slower in the links benchmark), and no `async` (a check's throw is returned as a
	 * rejection; as an async function a local call allocated about 250 B more).
	 */
	call(
		method: string,
		args: unknown,
		context: Context,
		caller: Caller,
		version: number,
		parent: TelemetryContext,
	): Promise<unknown> {
		let checked: ReturnType<typeof checkArgs>;
		let handler: Method | undefined;
		try {
			context.abortSignal?.throwIfAborted();
			// Its own served type: an old attempt answers old work by the contract it was made with.
			const served = this.#served;
			const own = this.#members!.methods.get(method);
			// A method its caller's version marks grantable and it was not granted is refused before any mapping or
			// replacement runs, also one removed since.
			const at = own === undefined ? versionAt(served.contract, version) : undefined;
			const refused = at?.grantable.has(method) ? !this.granted.has(method) : version === served.contract.version;
			if (at !== undefined && refused) throw lacking(this.#object.label, served.contract, method, "method", at);
			checked = checkArgs(served.provider, method, args, version, context);
			const call = checked.kind === "call" ? checked.call : undefined;
			handler = call !== undefined ? (callArgs, ctx) => call(callArgs as Value, ctx) : own;
			if (handler === undefined) throw lacking(this.#object.label, served.contract, method, "method");
		} catch (error) {
			return Promise.reject(error);
		}
		const { host, served } = this.#object;
		const linked = withLinkedAbortSignal(this.#abort.signal, context);
		const callContext = linked.context;
		// A local object's handlers act as the host, its principal and its incarnation (§4); a remote one's as their
		// caller. The caller stays the reference's (presence, §19).
		const acting = served.kind === "remote" ? caller : { principal: host.principal, incarnation: host.incarnation };
		// Its span only when something records (§30: nothing else is made per call).
		const span = !served.traced || untraced(parent) ? undefined : this.#methodSpan(parent, method, acting, context);
		const ctx = new CallContext(
			span === undefined ? callContext : withTelemetry(span.span, callContext),
			acting,
			host,
			this,
		);
		// Admitted to the drain before the handler runs: the handler may end its own object before it returns.
		const running = Promise.withResolvers<unknown>();
		host.count("calls", 1);
		host.metrics.upDownCounter("chord.calls.in_flight").add(1);
		this.#running ??= new Map();
		this.#admit(this.#running, running.promise, () => {
			host.count("calls", -1);
			host.metrics.upDownCounter("chord.calls.in_flight").add(-1);
			linked.release();
			ctx.settle();
		});
		span?.endWhen(running.promise, "method_failed", callContext.abortSignal);
		// Plugin code, not type-checked: a synchronous throw or a plain value becomes the promise. Constants: the closure
		// captures them, not the `let`s above.
		const run = handler;
		const runArgs = checked.args;
		(async () => run(runArgs, ctx))().then(running.resolve, running.reject);
		const settled = awaitWithContext(running.promise, callContext);
		if (checked.kind === "call" || checked.result === undefined) return settled;
		// The handler's result is the current version's: its mapping back is the provider's (results are not validated).
		const back = checked.result;
		return settled.then((result) => back(result as Value));
	}

	/** The `chord.method` span of a call of `method` acting as `acting`, under `parent`. */
	#methodSpan(parent: TelemetryContext, method: string, acting: Caller, context: Context): OpenSpan<"chord.method"> {
		const { host, served, label } = this.#object;
		return new OpenSpan(parent, "chord.method", {
			"chord.host": host.spanHost,
			type: served.contract.name,
			member: method,
			object: capped(label),
			"principal.kind": capped(acting.principal?.kind ?? "none"),
			...host.principalAttributes(acting.principal, context),
		});
	}

	/**
	 * The keyed member `member`'s ultimate slot (slice 6a §12, rule 22: through re-exposures); an unknown one fails
	 * `invalid/member`.
	 */
	keyedMember(member: string): KeyedSlot {
		const keyed = this.#members!.keyed.get(member);
		if (keyed === undefined) throw invalid("member", `${this.#object.label} has no keyed member "${member}"`);
		return keyed.kind === "own" ? keyed.slot : keyed.binding.keyedSlot(keyed.member);
	}

	/** The named query `name` of its `queries` member `member`; an unknown one fails `invalid/member`. */
	queryMember(member: string, name: string): OwnQuery {
		const query = this.#members!.queries.get(member)?.get(name);
		if (query === undefined) throw invalid("member", `${this.#object.label} has no query "${member}.${name}"`);
		return query;
	}

	/** The keyed members as checked: what each is (`KeyedBinding`), for the keys its object holds across attempts. */
	get keyedMembers(): ReadonlyMap<string, KeyedBinding> {
		return this.#members!.keyed;
	}

	/**
	 * State member `member` as a consumer of `version` follows it: its own member at its version, else its shared mapping
	 * for that version (`AdaptedMembers`); `invalid/member` for one it lacks, `contract_mismatch` for a version or
	 * member its provider refuses.
	 */
	memberAt(member: string, version: number): DeriveSource {
		if (version === this.#served.contract.version) return this.member(member);
		return this.#adaptedAt(version).member(member);
	}

	/** How a consumer of `version` reads keyed member `member`'s documents: mapped when older (`undefined`: as they are). */
	keyMapping(member: string, version: number): ((current: JsonValue) => JsonValue) | undefined {
		if (version === this.#served.contract.version) return undefined;
		return this.#adaptedAt(version).keyed(member);
	}

	/**
	 * Pins `key` of keyed member `member` on this instance, loaded (its own slot's document, or the re-exposed reference's
	 * key), as a consumer of `version` reads it (mapped when older); `release` lets it go.
	 */
	async pinKey(member: string, key: string, version: number, context: Context): Promise<PinnedKey> {
		const keyed = this.#members!.keyed.get(member);
		if (keyed === undefined) throw invalid("member", `${this.#object.label} has no keyed member "${member}"`);
		const raw =
			keyed.kind === "own"
				? await pinned(keyed.slot, key, context)
				: await keyed.binding.pinKey(keyed.member, key, context);
		if (version === this.#served.contract.version) return raw;
		try {
			const mapped = this.#adaptedAt(version).key(member, raw.source);
			return {
				source: mapped.source,
				release: () => {
					mapped.release();
					raw.release();
				},
			};
		} catch (error) {
			raw.release();
			throw error;
		}
	}

	/** No consumer of `version` is left: its shared mapping goes. */
	dropVersion(version: number): void {
		const adapted = this.#extras?.adapted?.get(version);
		if (adapted === undefined) return;
		this.#extras!.adapted!.delete(version);
		adapted.detach(this.#object.ended());
	}

	/** Why its provider refuses consumers of `version` (`refusal`), found once per version; `undefined` when it serves them. */
	refusalAt(version: number): ChordError | undefined {
		return version === this.#served.contract.version ? undefined : this.#adaptedAt(version).refused;
	}

	/** Its mapping for `version`, made by the first use, reading this instance's own members and provider. */
	#adaptedAt(version: number): AdaptedMembers {
		this.#more().adapted ??= new Map();
		let adapted = this.#extras!.adapted!.get(version);
		if (adapted === undefined) {
			const { host, label } = this.#object;
			adapted = new AdaptedMembers(
				{
					served: this.#served,
					granted: this.granted,
					label,
					batch: host.batch,
					member: (name) => this.member(name),
					event: (name) => this.#members?.events.get(name),
					report: (member, error) => host.report({ kind: "derive_failed", object: label, member, error }),
					reportEvent: (member, error) =>
						host.report({ kind: "event_mapping_failed", object: label, member, version, error }),
					metrics: host.metrics,
				},
				version,
			);
			this.#extras!.adapted!.set(version, adapted);
		}
		return adapted;
	}

	/**
	 * Event member `member`'s node as a binding of `version` taps it: its own at its version, else its shared mapping
	 * for that version; `undefined` for one it lacks (not granted, or removed since that version), before the members
	 * check, and for a version its provider does not serve.
	 */
	eventNode(member: string, version: number): EventNode | undefined {
		if (version === this.#served.contract.version) return this.#members?.events.get(member);
		return this.#adaptedAt(version).event(member);
	}

	/** The state member `member`, as Chord follows it; one it lacks fails (`forbidden` when not granted). */
	member(member: string): DeriveSource {
		const source = this.#members!.state.get(member);
		if (source === undefined) throw lacking(this.#object.label, this.#served.contract, member, "state member");
		return source;
	}

	/**
	 * Ends the attempt at once (the seal fence): calls, openers and routines aborted with `error` (their callers
	 * rejected with it), its transactions refused and the one holding the line discarded, its job invocations cut off
	 * (an in-memory run ends `aborted` with `runs` as its reason: `reload` for a native restart, slice 7b §8); documents
	 * stay readable.
	 */
	seal(error: ChordError, runs: CutReason = "restart"): void {
		// A drained old attempt stops counting as old work at its seal (once: an abandoned attempt is not draining).
		if (this.draining) this.#object.host.oldWork.close();
		this.abandon({ kind: "ended", error });
		const { documents } = this.#object;
		documents.fence(this.#token);
		for (const job of this.#extras?.jobs?.values() ?? NO_ITEMS) job.seal(error, runs);
	}

	/**
	 * Tears a sealed attempt down: waits for its running handlers, routine calls and runs up to the host's
	 * `closeTimeout` (the drain), then closes its natives in reverse with `reason`. Resolves with the closes that threw.
	 */
	async close(reason: NativeCloseReason): Promise<CloseFailed[]> {
		const { host, label } = this.#object;
		if ((await this.#drained()) === "timeout") host.report({ kind: "drain_timeout", object: label });
		// The close writer: the persisted runs the seal stopped, and the held state changes (slice 6b §4.2).
		for (const job of this.#extras?.jobs?.values() ?? NO_ITEMS) await job.writeAtClose(this.#context);
		// Work stuck past the drain keeps running, but no longer counts as a call or holds its `ctx.get` references.
		cleanUp(this.#running);
		cleanUp(this.#extras?.routineRun?.calls);
		cleanUp(this.#extras?.runs);
		const failures: CloseFailed[] = [];
		for (const native of [...this.#natives].reverse()) {
			const failure = await native.close(reason);
			if (failure !== undefined) failures.push(failure);
		}
		return failures;
	}

	/**
	 * The drain at its end, bounded by `closeTimeout`: its running calls (unless a restart's `drainCalls` waited for them
	 * already), routine calls and job invocations.
	 */
	#drained(): Promise<"settled" | "timeout"> {
		const { close } = this.#object.host.timeouts;
		const running = this.#extras?.reloaded?.callsDrained === true ? NO_WORK : (this.#running ?? NO_WORK);
		const runs = this.#extras?.runs;
		const routineCalls = this.#extras?.routineRun?.calls;
		// Most attempts have only calls: no list is made for them.
		if (routineCalls === undefined && runs === undefined) return drained(running.keys(), running.size, close);
		const all = [...running.keys(), ...(routineCalls ?? NO_WORK).keys(), ...(runs ?? NO_WORK).keys()];
		return drained(all, all.length, close);
	}

	/**
	 * Detaches its derives and live queries (once their object no longer needs them: reads throw `released`, their
	 * watches end; no commit re-runs the queries), its followed sources (their observers detached, their watches ended)
	 * and its writables (their watches ended).
	 */
	detach(): void {
		const declarations = this.#extras?.registryDeclarations;
		const adapted = this.#extras?.adapted;
		// The object's error only for what takes it: an attempt with none of these made one for nothing (0.3 KiB).
		const takers =
			adapted !== undefined ||
			this.#derives.length > 0 ||
			this.#queries.length > 0 ||
			this.#readers.length > 0 ||
			(declarations !== undefined && declarations.writables.length > 0);
		// Left out only when no loop below runs that takes it.
		const ended = (takers ? this.#object.ended() : undefined) as ChordError;
		if (adapted !== undefined) for (const each of adapted.values()) each.detach(ended);
		if (this.#extras !== undefined) this.#extras.adapted = undefined;
		for (const derive of this.#derives) derive.detach(ended);
		for (const { live } of this.#queries) live.detach(ended);
		for (const reader of this.#readers) reader.close(ended);
		// The named queries it offered are offered no more (slice 14 §3.2): their readers' reads leave the store's
		// index before a successor prepares the tables, and read the successor's queries when it is live.
		for (const handle of this.#extras?.tables?.values() ?? NO_ITEMS) handle.store.reads.retire(handle);
		for (const follow of this.#follows) follow.detach();
		for (const source of this.#extras?.sources ?? NO_ITEMS) source.detach();
		const events = this.#members?.events;
		if (events !== undefined && events.size > 0) {
			for (const node of events.values()) if (node instanceof ReexposedEvents) node.detach();
		}
		if (declarations !== undefined) for (const writable of declarations.writables) writable.detach(ended);
	}

	/** Releases its references and registry reads. */
	releaseReferences(): void {
		for (const { binding } of this.#references) binding.release();
		const declarations = this.#extras?.registryDeclarations;
		if (declarations !== undefined) for (const release of declarations.reads.splice(0)) release();
	}

	/** Its declaration of table `table` (SQL name), if it declared one. */
	declaredTable(table: string): TableDefinition | undefined {
		for (const handle of this.#extras?.tables?.values() ?? NO_ITEMS)
			if (handle.sql.table === table) return handle.definition;
		return undefined;
	}

	/** The activation steps; each catches its own failures with their kind (the table in slice 2's spec). */
	async #activate(deadline: Deadline): Promise<Activation> {
		let implementation: unknown;
		let dependencies: readonly Dependency[] = NO_ITEMS;
		try {
			implementation = this.#declare();
			// Right after the factory, before anything can fail: a failed attempt keeps its wake signals.
			this.#object.retryOn(this.#extras?.registryDeclarations?.retrySources ?? NO_ITEMS);
			const { documents, host } = this.#object;
			// The load phase: no host data operation of the host runs meanwhile (its gate), so what loads is current.
			const entering = host.hostData.enter();
			if (entering !== undefined) await entering;
			try {
				// The object holds the pins from now on.
				const pins = this.#pins;
				this.#pins = NO_ITEMS;
				documents.hydrate(this.#declared ?? NO_DOCUMENTS, pins, this.#opening);
				const loading = documents.load(this.#opening);
				if (loading !== undefined) await loading;
				// Awaited only with tables: an object without any takes no extra turn here.
				const tables = this.#extras?.tables;
				if (tables !== undefined && tables.size > 0) await this.#prepareTables(tables, deadline);
				else if (host.store !== undefined) this.#bindSets(NO_ITEMS, host.store);
				for (const { live, target } of this.#queries) await live.load(target, this.#opening);
			} finally {
				host.hostData.leave();
			}
			// A persisted job's runs, loaded once per object: rebuilt before anything runs.
			for (const job of this.#extras?.jobs?.values() ?? NO_ITEMS) await job.load(this.#opening);
			for (const { binding, contract, params } of this.#references) {
				host.bind(binding, contract, params, this.#opening);
			}
			// Once all are bound: a dependency made here may have bound back to this object meanwhile.
			for (const { binding } of this.#references) {
				const { target } = binding;
				if (target !== undefined) this.#object.assertNoCycle(target, this.#opening);
			}
			// Needed only up to the dependency check: a live attempt keeps none.
			dependencies = this.#dependencies ?? NO_ITEMS;
			this.#dependencies = undefined;
			for (const dependency of dependencies) {
				// Read from here until its references are released: an older version's mapping is kept meanwhile.
				if (dependency.kind === "registry") this.#declarations().reads.push(dependency.value.read());
			}
		} catch (error) {
			return this.#broken(error);
		}
		// Parked only when something is not live yet (most activations find their dependencies live).
		if ((dependencies.length > 0 && checkDependencies(dependencies).kind !== "live") || this.#pinsKeys()) {
			const parked = await this.#park(dependencies, (long) => this.#checkDependencies(dependencies, long), deadline);
			if (parked !== undefined) return parked;
		} else {
			this.#settleCheck(undefined);
			// Its own steps start in a later turn: an object ended in the turn it was made opens nothing.
			await undefined;
		}
		return this.#ownSteps(implementation, deadline);
	}

	/**
	 * Parks until `step` finds nothing to wait for (dependency model §3), with no timer: the deadline paused,
	 * `parked_long`'s report the only clock. `step` runs at every change of what the attempt waits on (after its batch):
	 * its `dependencies`, a pinned key, its admission; what it finds is shown on its object. Resolves `undefined` once
	 * the attempt may go on, else with how it ends: abandoned, or broken (a cycle, an ended dependency).
	 */
	async #park(
		dependencies: readonly Dependency[],
		step: (long: ParkedLong) => Promise<Parking>,
		deadline: Deadline,
	): Promise<NotLive | undefined> {
		const object = this.#object;
		deadline.pause();
		this.#parked = dependencies;
		object.waitsFor(dependencies);
		// Waiters on a registry are woken when its value turns usable or its failure changes.
		const waits: (() => void)[] = [];
		for (const each of dependencies) if (each.kind === "registry") waits.push(each.value.wait(this));
		const long = new ParkedLong(object);
		try {
			for (;;) {
				this.#moved = false;
				const parking = await step(long);
				if (this.#abandoned !== undefined) return this.#abandoned;
				if (parking.kind === "broken") return { kind: "failed", cause: { kind: "broken", error: parking.error } };
				// Changed while it checked (its keys loaded, its admission settled): checked again.
				if (parking.kind === "ready" && !this.#moved) {
					// Its own steps follow: `loading` until its outcome (a failure shows as the failure, not this).
					object.unparked(this);
					this.#unparked();
					return undefined;
				}
				if (parking.kind === "parked") {
					object.parked(this, parking.shown, parking.firstPass);
					if (parking.cause !== undefined) this.#settleCheck(parking.cause);
					this.#parkedOn(parking.shown);
				}
				if (!(await this.#nextChange())) return this.#abandoned!;
			}
		} finally {
			this.#parkEnded();
			long.stop();
			for (const release of waits) release();
			this.#parked = undefined;
			object.waitsFor(NO_ITEMS);
			deadline.resume();
		}
	}

	/**
	 * One check of its factory's dependencies while it parks on them: once all are live, the keys the factory pinned on
	 * them are loaded (a failed load parks it `waiting` until the next change or a retry).
	 */
	async #checkDependencies(dependencies: readonly Dependency[], long: ParkedLong): Promise<Parking> {
		const check = checkDependencies(dependencies);
		if (check.kind !== "parked") this.#settleCheck(undefined);
		if (check.kind === "broken") return check;
		if (check.kind === "parked") {
			long.blockedBy(check.blocker);
			return { kind: "parked", shown: check.shown, firstPass: check.firstPass, cause: parkedCause(check) };
		}
		const pinned = await pinKeys(this.#bindings(), long, this.#opening);
		return pinned === undefined ? READY : { kind: "parked", shown: pinned, firstPass: true, cause: undefined };
	}

	/** The references its factory declared. */
	#bindings(): Binding[] {
		return this.#references.map(({ binding }) => binding);
	}

	/** Its dependencies are live after it parked: its own steps run in a new activation span, linked to the parked one. */
	#unparked(): void {
		this.#parkEnded();
		const parked = this.#activation;
		if (parked?.ended) this.#startActivation(parked.span);
	}

	/**
	 * Waits for the next change of a dependency (at once when one came during the check); `false` when the attempt was
	 * abandoned meanwhile (its end, the only thing that stops the wait).
	 */
	async #nextChange(): Promise<boolean> {
		if (this.#moved) return true;
		this.#changed = Promise.withResolvers();
		try {
			await awaitWithContext(this.#changed.promise, this.#opening);
			return true;
		} catch {
			return false;
		} finally {
			this.#changed = undefined;
		}
	}

	/**
	 * Opens its readers of named queries and waits until each has a value (slice 14 §3.2), after its derives are
	 * attached (the ones computing arguments are computed here) and before the others are computed (they may read a
	 * live query). A reader that cannot read yet, or whose first run failed, parks the attempt on it (`loading`, or
	 * `failed { waiting }`): its next adoption or a move of what it reads checks again. Arguments its
	 * provider refuses and a builder that throws fail the attempt `broken`. Resolves `undefined` once all have
	 * values, else with how the attempt ends.
	 */
	async #awaitReaders(deadline: Deadline): Promise<NotLive | undefined> {
		const label = `${this.#object.label}: a live query`;
		// Follows a reader this attempt is parked on: its next adoption (a good run heals it) checks again.
		const wake: Dependent = { invalidate: () => this.dependencyMoved(), sourceRetired: () => {} };
		const open = (long: ParkedLong) => openReaders(this.#readers, wake, long, label, this.#opening);
		try {
			return await this.#park(NO_ITEMS, open, deadline);
		} finally {
			for (const reader of this.#readers) reader.source.dependents.delete(wake);
		}
	}

	/**
	 * A dependency of this parked attempt changed (its state, its cause, its first outcome): it checks again after the
	 * batch that changed it, once however many changed. A change while it checks or loads pinned keys is remembered
	 * (`#moved`); one outside parking costs a flag.
	 */
	dependencyMoved(): void {
		if (this.#moved) return;
		this.#moved = true;
		if (this.#changed !== undefined) queueMicrotask(() => this.#changed?.resolve());
	}

	/** A registry it is parked on closed with its host: the parked attempt ends with `error`. */
	closed(error: ChordError): void {
		this.abandon({ kind: "ended", error });
	}

	/** Whether its factory pinned keys on its dependencies' keyed members (`at(key)`), which load while it is parked. */
	#pinsKeys(): boolean {
		for (const { binding } of this.#references) if (binding.pinsKeys) return true;
		return false;
	}

	/**
	 * `ref.retry()` on its parked object (`failed { waiting }`): passed on to every failed dependency (a broken or
	 * transient one retries, a parked one passes it on, a request waiting in an index is left alone), as a step of
	 * `walk`; then it checks again (a key that failed to load is loaded again).
	 */
	retryDependencies(walk: RetryWalk): void {
		for (const dependency of this.#parked ?? NO_ITEMS) {
			if (dependency.kind === "reference" && dependency.binding.refState.kind === "failed") {
				dependency.binding.retry(walk);
			}
		}
		this.dependencyMoved();
	}

	/**
	 * The steps after the dependency check (its own: the member check, derives attached, the readers of named queries,
	 * natives, followed sources, derives computed, the keys references pin on its keyed members), under the deadline.
	 * A dependency that leaves `live` meanwhile changes nothing (R18 after live).
	 */
	async #ownSteps(implementation: unknown, deadline: Deadline): Promise<Activation> {
		let members: Members;
		try {
			members = checkImplementation(
				this.#object.served.contract,
				implementation,
				this.#extras?.sourceOwner,
				this.granted,
			);
			this.#members = members;
			// Fed by their references from now on (the object's bindings tap them once it is live).
			for (const node of members.events.values()) if (node instanceof ReexposedEvents) node.attach();
			const declarations = this.#extras?.registryDeclarations;
			if (declarations !== undefined) declarations.contributions = this.#resolveContributions(declarations);
			const { host, label } = this.#object;
			attachDerives(this.#derives, members.state, (member) => (error) => {
				// During activation a throwing derive fails the attempt, which `activation_failed` reports alone.
				if (!this.#isLive) return;
				host.report({ kind: "derive_failed", object: label, ...(member === undefined ? {} : { member }), error });
			});
		} catch (error) {
			return this.#broken(error);
		}
		// Before the natives: an attempt that waits on a reader holds none (design §6), as one parked on a dependency.
		// Awaited only with readers: an attempt without any takes no extra turn before its natives open.
		if (this.#readers.length > 0) {
			const reading = await this.#awaitReaders(deadline);
			if (reading !== undefined) return reading;
		}
		for (const native of this.#natives) {
			// An attempt abandoned before this open (ended while it waited) closed its natives already: none opens late.
			if (this.#abandoned !== undefined) return this.#abandoned;
			try {
				await awaitWithContext(native.open(this.#opening), this.#opening);
			} catch (error) {
				return this.#abandoned ?? { kind: "failed", cause: openFailure(error, this.#object.label) };
			}
		}
		for (const follow of this.#follows) {
			if (this.#abandoned !== undefined) return this.#abandoned;
			try {
				await awaitWithContext(follow.attach(this.#opening), this.#opening);
			} catch (error) {
				const cause: FailureCause = { kind: "transient", error: asChordError(error, this.#object.label) };
				return this.#abandoned ?? { kind: "failed", cause };
			}
		}
		try {
			for (const derive of this.#derives) void derive.value;
		} catch (error) {
			return this.#broken(error);
		}
		return this.#abandoned ?? { kind: "live" };
	}

	/** Its declared contributions, as Chord follows them (its references are live now), by its plugin and type. */
	#resolveContributions({ declared }: RegistryDeclarations): readonly RegistryContribution[] {
		const { served, host } = this.#object;
		const contributor = { plugin: served.plugin, type: served.contract.name };
		return declared.map(({ registry, value }) =>
			contributionOf(host.registryRecord(registry.name), contributor, registry.version, value),
		);
	}

	/**
	 * Brings the declared tables to their definitions before the references are bound (slice 6a §9): created fresh or
	 * migrated eagerly, with the `readyTimeout` deadline paused meanwhile (resumed with the budget it had left).
	 */
	async #prepareTables(declared: ReadonlyMap<string, TableHandle>, deadline: Deadline): Promise<void> {
		const handles = [...declared.values()];
		const tables = handles.map(({ definition, sql }) => ({ definition, table: sql.table }));
		const fence = { admit: () => !this.#token.sealed && this.#abandoned === undefined, adopt: () => {} };
		const { store } = handles[0]!;
		// Every read over a table that is created or migrated now waits until it is ready (slice 14 §5): a migration's
		// chunks are not one commit, and a failed one leaves the table held.
		for (const { definition, sql } of handles) {
			const recorded = store.table(sql.table);
			if (recorded?.version !== definition.version || recorded.state !== "ready") store.reads.hold(sql.table);
		}
		deadline.pause();
		try {
			await prepareTables(tables, store, fence, this.#object.label, this.#opening);
		} finally {
			deadline.resume();
		}
		this.#bindSets(handles, store);
	}

	/**
	 * The bindings of column sets follow this attempt's declarations (the committed code, slice 14 §5): each set a
	 * table exposes is bound to it, a set its object bound before and no table exposes now is dropped; then the tables
	 * are ready, and the reads over them compile again and run once. An attempt that declares no table drops what
	 * its object had bound.
	 */
	#bindSets(handles: readonly TableHandle[], store: ChordStore): void {
		const object = this.#object;
		const { reads } = store;
		const exposed = new Set<string>();
		for (const { definition, sql } of handles) {
			const set = definition.exposes?.name;
			if (set === undefined) continue;
			exposed.add(set);
			reads.bind(set, { table: sql.table, definition }, object);
		}
		for (const set of reads.boundBy(object)) if (!exposed.has(set)) reads.unbind(set, object);
		for (const { sql } of handles) reads.ready(sql.table);
	}

	/**
	 * Runs the factory with declarations open; the member check establishes what it returned. A throwing factory
	 * releases its pins.
	 */
	#declare(): unknown {
		this.#declaring = true;
		try {
			const { served, params, principal } = this.#object;
			if (served.kind === "local") return served.factory(params, this);
			// A remote object's identity has its principal; an admitted one's factory gets what its admission allowed,
			// and its grantable members are built while declarations are open (slice 15 §1.3).
			const admitted = this.#admitted;
			if (admitted === undefined) return served.factory(params, principal!, this);
			// An object's decision reads its value against its contract's grants: an `AdmittedValue`.
			const implementation = served.factory(params, principal!, admitted.value as AdmittedValue, this);
			return grantedImplementation(served.contract, implementation, admitted.granted);
		} catch (error) {
			for (const release of this.#pins) release();
			throw error;
		} finally {
			this.#declaring = false;
		}
	}

	/**
	 * Persisted data needs a stable identity (P3: a `local` type with empty params, also checked by the types) and the
	 * host's store; returns the store.
	 */
	#assertPersistable(what: string): ChordStore {
		const { host, served, label } = this.#object;
		if (served.kind !== "local" || contractData(served.contract).params.fields.length > 0) {
			throw new Error(`${label}: ${what}: persist needs a stable identity (a local type with empty params)`);
		}
		if (host.store === undefined) throw new Error(`${label}: ${what}: persist needs a store`);
		return host.store;
	}

	/**
	 * Adds `running` to `work` (its calls, routine calls or job invocations: the drain), with `cleanup` run once: when
	 * it settles, or at teardown if it never does.
	 */
	#admit(work: Work, running: Promise<unknown>, cleanup?: () => void): void {
		work.set(running, cleanup);
		// Out of the map already: the teardown ran the cleanup.
		const settled = (): void => {
			if (work.delete(running)) cleanup?.();
		};
		running.then(settled, settled);
	}

	/** Whom this object's own work acts for: a remote object as its principal, a local one as the host; from this host. */
	#caller(): Caller {
		const { host, served, principal } = this.#object;
		return { principal: served.kind === "remote" ? principal : host.principal, incarnation: host.incarnation };
	}

	#broken(error: unknown): NotLive {
		const cause: FailureCause = { kind: "broken", error: asChordError(error, this.#object.label) };
		return this.#abandoned ?? { kind: "failed", cause };
	}

	/** Its extras, made by the first feature that needs one (all of them start undefined). */
	#more(): AttemptExtras {
		this.#extras ??= {
			adapted: undefined,
			routineRun: undefined,
			routines: undefined,
			jobs: undefined,
			tables: undefined,
			listed: undefined,
			runs: undefined,
			endedEarly: undefined,
			registryDeclarations: undefined,
			sourceOwner: undefined,
			sources: undefined,
			reloaded: undefined,
		};
		return this.#extras;
	}

	#declarations(): RegistryDeclarations {
		const more = this.#more();
		more.registryDeclarations ??= {
			reads: [],
			retrySources: [],
			writables: [],
			declared: [],
			contributions: NO_ITEMS,
		};
		return more.registryDeclarations;
	}

	#assertDeclaring(declaration: string): void {
		if (!this.#declaring) {
			throw new Error(`${this.#object.label}: self.${declaration} is valid only in the factory`);
		}
	}
}

/** Pins `key` on `slot` and loads it when it is not in memory; a failed load releases the pin. */
async function pinned(slot: KeyedSlot, key: string, context: Context): Promise<PinnedKey> {
	const release = slot.pin(key, context);
	try {
		await slot.ensure(key, context);
	} catch (error) {
		release();
		throw error;
	}
	return { source: slot.source(key), release };
}
