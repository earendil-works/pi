// Attempts (§6, §13, §14, §15): one activation of an object, a fresh instance each time. It is the `self` its factory
// declares with (handles to the object's documents and jobs, under its seal token); it runs the activation steps,
// each failing with its own kind; it takes the live object's calls and starts its routines and jobs; and it ends with
// its seal (slice 6a §1.3), the drain and the closes of its natives. A reload's swap hands it over (slice 7b §5): its
// routines stop and hand over to the new attempt's, its jobs to the new attempt's, and it is sealed once its calls
// settled.

import { awaitWithContext, type Context, withAbortSignal } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { NativeWatchable, Watchable, WatchEnd } from "../../watch.ts";
import type { Contract, Implementation, ParamsOf } from "../contracts/index.ts";
import { contractData, type ShapeOf } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal } from "../data/index.ts";
import { asChordError, checkArgs, checkParams, invalid, openFailure, type Value } from "../data/internal.ts";
import type { HandleOf, JsonObject, StateDefinition, Tx } from "../documents/index.ts";
import {
	type AnyDefinition,
	type KeyDeclarer,
	type KeyedSlot,
	type KeySource,
	SealToken,
} from "../documents/internal.ts";
import type { JobDefinition, JobHandle, JobImplementation } from "../jobs/index.ts";
import { type AnyJobImplementation, type CutReason, Job } from "../jobs/internal.ts";
import type { Contribution, Registry, RegistryValue } from "../registries/index.ts";
import type { RegistryContribution, RegistryWaiter } from "../registries/internal.ts";
import type { Writable } from "../state/index.ts";
import { Derive, type DeriveSource, WritableSource } from "../state/internal.ts";
import type { Columns } from "../store/columns.ts";
import { tableSqlName } from "../store/sql.ts";
import type { ChordStore } from "../store/store.ts";
import type { TableDefinition } from "../store/table.ts";
import { type Table, TableHandle } from "../store/table-handle.ts";
import { prepareTables } from "../store/table-migration.ts";
import { AdaptedMembers } from "./adapted.ts";
import { CallContext, type Caller, type Ctx, withLinkedAbortSignal } from "./ctx.ts";
import { Deadline } from "./deadline.ts";
import { checkDependencies, type Dependency, ParkedLong, parkedCause, waitingOn } from "./dependencies.ts";
import { type FollowAttach, FollowSource } from "./follow.ts";
import type { HostError } from "./host.ts";
import {
	attachDerives,
	checkImplementation,
	contributionOf,
	type KeyedBinding,
	type Members,
	type Method,
} from "./members.ts";
import {
	type CloseFailed,
	drained,
	type Native,
	type NativeCloseReason,
	NativeHandle,
	type NativeOptions,
	type NativeSlot,
} from "./native.ts";
import type { ChordObject, Served } from "./object.ts";
import type { Failed } from "./ref-state.ts";
import type { Binding, CheckedParams, Reference, RetryWalk } from "./reference.ts";
import { type RetrySource, retrySource } from "./retry-on.ts";
import {
	type OnHandler,
	type OnLiveHandler,
	type OnNativeHandler,
	type RoutineDeclarations,
	Routines,
} from "./routines.ts";

/**
 * What a factory declares with. Declarations (`state`, `derive`, `get`, `registry`, `writable`, `retryOn`, `open`,
 * `on`, `onLive`, `job`) are valid only while it runs. `P` is the app's principal type, which the ctx of routine calls
 * and job runs carry.
 */
export interface Self<P extends Principal = Principal> extends RoutineDeclarations<P> {
	/** This object's documents of `definition`, in memory for its life (across its attempts). */
	state<D extends StateDefinition<JsonObject, boolean, false>>(definition: D): HandleOf<D>;
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
}

/**
 * What the factory of a `local` type with empty params declares with: one object per host and type, so its data may
 * persist (P3). `P` as for `Self`.
 */
export interface StoreSelf<P extends Principal = Principal> extends Self<P> {
	/** This object's documents of `definition`: in memory for its life, or persisted in the host's store. */
	state<D extends StateDefinition<JsonObject, boolean, boolean>>(definition: D): HandleOf<D>;
	/** This object's table `definition` in the host's store, once per table name. */
	table<C extends Columns, K extends readonly string[]>(definition: TableDefinition<C, K>): Table<C, K>;
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
 * identity and returns one variant, `{ variant, members }`. Methods get a `Ctx` for the app's principal type `P`.
 */
export type Factory<C extends Contract, P extends Principal = Principal> = ShapeOf<C>["kind"] extends "local"
	? (params: ParamsOf<C>, self: keyof ParamsOf<C> extends never ? StoreSelf<P> : Self<P>) => Implementation<C, Ctx<P>>
	: (params: ParamsOf<C>, principal: P, self: Self<P>) => Implementation<C, Ctx<P>>;

/** No declarations of a kind: the shared empty list. */
const NONE: readonly never[] = [];

/** Running work of one kind (calls, routine calls, job invocations), with the bookkeeping each runs once. */
type Work = Map<Promise<unknown>, (() => void) | undefined>;

/** Its routines once started: aborted when they stop (its seal, a reload's handover or restart), and their running calls. */
type RoutineRun = { readonly abort: AbortController; readonly calls: Work };

/**
 * What a reload did to an attempt: `started` (a reload started it), `handedOver` (a swap: its jobs are the new
 * attempt's, its invocations finish on their own), `callsDrained` (a swap or restart waited for its calls: its end's
 * drain does not again), `routinesStopped` (its routines stopped, and do not start late after a handover).
 */
type Reloaded = { started: boolean; handedOver: boolean; callsDrained: boolean; routinesStopped: boolean };

/** A first dependency check that did not park: the shared answer. */
const NOT_PARKED = { done: true, cause: undefined } as const;

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

/** The error of an object, or a getter, that waited `ms` without the object going live. */
export function notLive(label: string, ms: number): ChordError {
	return new ChordError({ code: "unavailable", message: `${label}: did not become live within ${ms} ms` });
}

/**
 * One attempt of an object. Activation: factory, documents hydrated (the object's slots), references bound, then parked
 * until every dependency is live (no timer: the deadline paused), then its own steps: natives opened one after
 * another, followed sources attached, members checked, derives computed; bounded by the host's `readyTimeout`.
 * Ending: sealed at once (calls aborted, its transactions refused and the one holding the line discarded, its job
 * invocations cut off), then the drain, the closes in reverse, derives detached; its object releases its references.
 * Documents and job runs stay on the object.
 */
export class Attempt implements StoreSelf, KeyDeclarer, RegistryWaiter {
	readonly #object: ChordObject;
	/** The type its object was served as when it was made: its provider's `accepts` map its older consumers. */
	readonly #served: Served;
	/** Its shared mappings for the consumers of older versions (Q10), by version; made by the first. */
	#adapted: Map<number, AdaptedMembers> | undefined;
	/** The object's context: the natives' closes run under it. */
	readonly #context: Context;
	/** Aborted when the attempt is abandoned or ends: openers, activation's waits and calls run under its signal. */
	readonly #abort = new AbortController();
	/** The object's context under this attempt's signal. */
	readonly #opening: Context;
	/** The seal token its handles and transactions carry (the seal fence). */
	readonly #token = new SealToken();
	/** Its routines once they started (most attempts have none). */
	#routineRun: RoutineRun | undefined;
	/** The documents it declared, by name: "declared twice" is per attempt. */
	readonly #declared = new Map<string, AnyDefinition>();
	/** Its factory's `at(key)` pins: the object holds them from its factory's return to the next one's (rule 6). */
	readonly #pins: (() => void)[] = [];
	#declaring = false;
	/** Set once it went live: its derives' failures are reported from then on (`derive_failed`). */
	#isLive = false;
	/** The checked implementation and, for a remote object, its variant, once activation checked them. */
	#members: Members | undefined;
	#variant: string | undefined;
	readonly #derives: Derive[] = [];
	/** Its followed sources, attached in declaration order after the natives. */
	readonly #follows: FollowSource[] = [];
	readonly #routines = new Routines();
	readonly #jobs = new Map<string, Job>();
	/** The tables it declared, by name. */
	readonly #tables = new Map<string, TableHandle>();
	/** References this attempt declared with `self.get` (params checked), bound during activation. */
	readonly #references: { readonly binding: Binding; readonly contract: Contract; readonly params: CheckedParams }[] =
		[];
	/**
	 * Its dependencies (`self.get` references and `self.registry` values) in declaration order: the parked cause and
	 * `parked_long` name the first that blocks. Made by the first; let go after the dependency check (a live attempt
	 * keeps none).
	 */
	#dependencies: Dependency[] | undefined;
	readonly #natives: NativeSlot[] = [];
	/**
	 * Running calls' handlers, routine calls and job runs, each with its bookkeeping (call counts, `ctx.get`
	 * references): an ending attempt waits for them (the drain); the bookkeeping runs once, when its work settles or at
	 * teardown for work stuck past the drain (decision "The seal fence" (4)). One map and one reaction per piece of work:
	 * the call path costs no more than before the cleanups.
	 */
	readonly #running: Work = new Map();
	/**
	 * Its running job invocations, as `#running`: the drain at its end waits for them; a swap does not (they finish on
	 * their old code, slice 7b §8). Made by the first.
	 */
	#runs: Work | undefined;
	/** What activation returns once the attempt was abandoned: a timeout, a cycle through its object, or its end. */
	#abandoned: NotLive | undefined;
	/** Its dependencies while it is parked on them (the dependency check); `undefined` otherwise. */
	#parked: readonly Dependency[] | undefined;
	/** A dependency changed since the last check: the parked attempt checks again (one check per batch of changes). */
	#moved = false;
	/** What a parked attempt waiting for a change waits on; resolved after the change's batch. */
	#changed: PromiseWithResolvers<void> | undefined;
	/** A followed source's end while this attempt activated: it fails as it goes live (if its activation returned). */
	#endedEarly: ChordError | undefined;
	/** Its registry reads, contributions, wake signals and writables, made by the first: most attempts have none. */
	#registryDeclarations: RegistryDeclarations | undefined;
	/**
	 * Its first dependency check, for a reload (its report, a swap's handover): waited for by someone, or done with why
	 * it parked (`undefined`: it did not). Made by the first who asks or by the check.
	 */
	#check:
		| { readonly done: false; readonly waiting: PromiseWithResolvers<FailureCause | undefined> }
		| { readonly done: true; readonly cause: FailureCause | undefined }
		| undefined;
	/** What a reload did to it, made by the first such step (most attempts never meet one). */
	#reloaded: Reloaded | undefined;

	constructor(object: ChordObject, context: Context) {
		this.#object = object;
		this.#served = object.served;
		this.#context = context;
		this.#opening = withAbortSignal(this.#abort.signal, context);
	}

	state<D extends StateDefinition<JsonObject, boolean, boolean>>(definition: D): HandleOf<D> {
		this.#assertDeclaring("state");
		const what = `state "${definition.name}"`;
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
		this.#pins.push(slot.pin(key, this.#opening));
		return slot.source(key);
	}

	table<C extends Columns, K extends readonly string[]>(definition: TableDefinition<C, K>): Table<C, K> {
		this.#assertDeclaring("table");
		const object = this.#object;
		const { served, label } = object;
		const store = this.#assertPersistable(`table "${definition.name}"`);
		if (this.#tables.has(definition.name)) throw new Error(`${label}: table "${definition.name}" is declared twice`);
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
		this.#tables.set(definition.name, handle);
		return handle as unknown as Table<C, K>;
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
		this.#derives.push(derive);
		return derive as unknown as Watchable<T>;
	}

	get<C extends Contract>(Type: C, params: ParamsOf<C>): Reference<C> {
		this.#assertDeclaring("get");
		const { host } = this.#object;
		const checked = checkParams(Type, params, this.#opening);
		const binding = host.reference(Type, this.#object, this.#caller(), {});
		this.#references.push({ binding, contract: Type, params: checked });
		this.#dependencies ??= [];
		this.#dependencies.push({ kind: "reference", binding });
		// The binding was built from `Type`'s members.
		return binding.reference as Reference<C>;
	}

	registry<C, V>(R: Registry<C, V>): RegistryValue<V> {
		this.#assertDeclaring("registry");
		const value = this.#object.host.registryRecord(R.name).value(R.version);
		this.#dependencies ??= [];
		this.#dependencies.push({ kind: "registry", value });
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
			position: this.#natives.length + 1,
			context: this.#context,
			report: (error: HostError) => host.report(error),
		};
		const native = new NativeHandle(open, close, closeTimeout, owner);
		this.#natives.push(native);
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
		this.#follows.push(source);
		return source as unknown as Watchable<T>;
	}

	on<T>(source: Watchable<T>, fn: OnHandler<T>): void;
	on<T>(source: NativeWatchable<T>, fn: OnNativeHandler<T>): void;
	on(source: Watchable<unknown> | NativeWatchable<unknown>, fn: (...args: never[]) => void | Promise<void>): void {
		this.#assertDeclaring("on");
		this.#routines.on(source, fn);
	}

	onLive(fn: OnLiveHandler): void {
		this.#assertDeclaring("onLive");
		this.#routines.onLive(fn);
	}

	job<A, R, S>(definition: JobDefinition<A, R, S>, implementation: JobImplementation<A, R, S>): JobHandle<A, R, S> {
		this.#assertDeclaring("job");
		const object = this.#object;
		if (this.#jobs.has(definition.name)) {
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
			admit: (running: Promise<unknown>, cleanup?: () => void) => this.#admit(this.#running, running, cleanup),
			admitRun: (running: Promise<unknown>, cleanup: () => void) => {
				this.#runs ??= new Map();
				this.#admit(this.#runs, running, cleanup);
			},
		};
		// The job keeps its runs as JSON and calls the implementation with them; the handle types them again.
		const records = object.jobRecords(definition as JobDefinition<unknown, unknown, unknown>);
		const job = new Job(records, implementation as unknown as AnyJobImplementation, owner);
		this.#jobs.set(definition.name, job);
		return job as unknown as JobHandle<A, R, S>;
	}

	/**
	 * Activates once `ending` (the previous instance's) has finished; `readyTimeout` bounds both (an attempt abandoned
	 * while it waits has opened nothing).
	 */
	async activate(ending: Promise<void> | undefined): Promise<Activation> {
		const { ready } = this.#object.host.timeouts;
		const deadline = new Deadline(ready, () => {
			this.abandon({ kind: "failed", cause: { kind: "transient", error: notLive(this.#object.label, ready) } });
		});
		try {
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
		this.#endedEarly ??= error;
		this.abandon({ kind: "failed", cause: { kind: "transient", error } });
	}

	/**
	 * The object went live: its jobs take starts and its routines start, in this turn; both stop when it is sealed.
	 * After a swap (`previous`, the attempt it replaced) its routines start once the previous attempt's routine calls
	 * finished (the handover per object, §14), calls never wait for it.
	 */
	live(previous?: Attempt): void {
		this.#isLive = true;
		const early = this.#endedEarly;
		if (early !== undefined) {
			this.#object.failLive(this, { kind: "transient", error: early });
			return;
		}
		for (const job of this.#jobs.values()) job.live();
		if (this.#routines.empty) return;
		if (previous === undefined) this.#startRoutines();
		else void previous.handOverRoutines().then(() => this.#startRoutines());
	}

	/** Starts its routines, unless it was sealed meanwhile. */
	#startRoutines(): void {
		if (this.#abandoned !== undefined || this.#reloaded?.routinesStopped === true) return;
		const { host, label } = this.#object;
		const run: RoutineRun = { abort: new AbortController(), calls: new Map() };
		this.#routineRun = run;
		this.#routines.start({
			label,
			host,
			caller: this.#caller(),
			context: withAbortSignal(run.abort.signal, this.#context),
			admit: (running, cleanup) => this.#admit(run.calls, running, cleanup),
		});
	}

	/** Its routines stop with `reason` (or may not start any more: `#startRoutines` asks the abandonment too). */
	#stopRoutines(reason: unknown): void {
		this.#routineRun?.abort.abort(reason);
	}

	/**
	 * A reload swaps this live attempt out (slice 7b §5): its routines stop, its jobs are handed over (their running
	 * invocations finish on this code), it takes no new starts; its calls run on until `drainCalls` settled.
	 */
	handOver(): void {
		this.#reload().handedOver = true;
		this.stopRoutines();
		for (const job of this.#jobs.values()) job.handOver();
	}

	/** Its routines stop (their ctx aborted); their running calls are waited for by the drain or the handover. */
	stopRoutines(): void {
		this.#reload().routinesStopped = true;
		this.#stopRoutines(
			new ChordError({ code: "released", reason: "ended", message: `${this.#object.label}: reloaded` }),
		);
	}

	/**
	 * The new attempt's routines may start: once this attempt's routine calls finished, bounded by `closeTimeout` (a
	 * stuck one is reported `drain_timeout`; the whole attempt is sealed by then: the swap's retirement drains its
	 * calls and routine calls on the same bound from the swap's start, then seals it, so a stuck call's later commit
	 * is refused `released`).
	 */
	async handOverRoutines(): Promise<void> {
		const { host, label } = this.#object;
		const calls = this.#routineRun?.calls ?? NO_WORK;
		if ((await drained(calls.keys(), calls.size, host.timeouts.close)) === "timeout") {
			host.report({ kind: "drain_timeout", object: label });
		}
	}

	/**
	 * Waits for its running calls and routine calls (not its job invocations), bounded by `closeTimeout`
	 * (`drain_timeout` reported): a reload's swap or restart lets them finish before the seal. Its end's drain then
	 * waits for them no more.
	 */
	async drainCalls(): Promise<void> {
		const { host, label } = this.#object;
		const calls = [...this.#running.keys(), ...(this.#routineRun?.calls ?? NO_WORK).keys()];
		this.#reload().callsDrained = true;
		if ((await drained(calls, calls.length, host.timeouts.close)) === "timeout") {
			host.report({ kind: "drain_timeout", object: label });
		}
	}

	/** A reload started it: once live, its object retries its blocked job runs (slice 7b §8). */
	startedByReload(): void {
		this.#reload().started = true;
	}

	/** Whether a reload started it. */
	get reloadStarted(): boolean {
		return this.#reloaded?.started === true;
	}

	/** What a reload did to it, made by the first such step. */
	#reload(): Reloaded {
		this.#reloaded ??= { started: false, handedOver: false, callsDrained: false, routinesStopped: false };
		return this.#reloaded;
	}

	/** Whether its factory declared job `name`. */
	declaresJob(name: string): boolean {
		return this.#jobs.has(name);
	}

	/** Whether its factory opens natives (`self.open`): a reload restarts it instead of swapping it. */
	get opensNatives(): boolean {
		return this.#natives.length > 0;
	}

	/**
	 * Its first dependency check: why it parked (`parkedCause`), `undefined` when it went on (its dependencies live) or
	 * its activation ended before (a reload's report and a swap's handover wait for it).
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
		return this.#registryDeclarations?.contributions ?? NONE;
	}

	/** The variant a remote object's factory chose; `undefined` for a local object. */
	get variant(): string | undefined {
		return this.#variant;
	}

	/** The state members, as Chord follows them. */
	get stateMembers(): ReadonlyMap<string, DeriveSource> {
		return this.#members!.state;
	}

	/**
	 * Calls a method for `caller`, bound at `version`: a method outside the variant fails `invalid/member` first (for an
	 * older version after its table's checks), then the arguments are checked against that version (L1) and, for an
	 * older one (Q10), mapped forwards, the handler's result mapped back, or the provider's replacement of a removed
	 * method run instead; a refused method fails `contract_mismatch`. The handler runs under a ctx aborted by the caller
	 * and by this attempt's end, admitted to the drain before it runs. Either rejects the caller at once; the handler
	 * runs on, its transactions refused, and the drain waits for it. Its `ctx.get` references are released when it
	 * settles. Measured choices (fix round 2): one body for every version (with the shared part in a helper method, a
	 * call over a link was about 10% slower in the links benchmark), and no `async` (a check's throw is returned as a
	 * rejection; as an async function a local call allocated about 250 B more).
	 */
	call(method: string, args: unknown, context: Context, caller: Caller, version: number): Promise<unknown> {
		let checked: ReturnType<typeof checkArgs>;
		let handler: Method | undefined;
		try {
			context.abortSignal?.throwIfAborted();
			const { served } = this.#object;
			const own = this.#members!.methods.get(method);
			if (own === undefined && version === served.contract.version) throw this.#noMethod(method);
			checked = checkArgs(served.provider, method, args, version, context);
			const call = checked.kind === "call" ? checked.call : undefined;
			handler = call !== undefined ? (callArgs, ctx) => call(callArgs as Value, ctx) : own;
			if (handler === undefined) throw this.#noMethod(method);
		} catch (error) {
			return Promise.reject(error);
		}
		const { host, served } = this.#object;
		const linked = withLinkedAbortSignal(this.#abort.signal, context);
		const callContext = linked.context;
		// A local object's handlers act as the host, its principal and its incarnation (§4); a remote one's as their
		// caller. The caller stays the reference's (presence, §19).
		const acting = served.kind === "remote" ? caller : { principal: host.principal, incarnation: host.incarnation };
		const ctx = new CallContext(callContext, acting, host);
		// Admitted to the drain before the handler runs: the handler may end its own object before it returns.
		const running = Promise.withResolvers<unknown>();
		host.count("calls", 1);
		this.#admit(this.#running, running.promise, () => {
			host.count("calls", -1);
			linked.release();
			ctx.settle();
		});
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

	/** The `invalid/member` error of a method outside the variant. */
	#noMethod(method: string): ChordError {
		return invalid("member", `${this.#object.label}${this.#inVariant()} has no method "${method}"`);
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

	/** The keyed members as checked: what each is (`KeyedBinding`), for the keys its object holds across attempts. */
	get keyedMembers(): ReadonlyMap<string, KeyedBinding> {
		return this.#members!.keyed;
	}

	/**
	 * State member `member` as a consumer of `version` follows it: its own member at its version, else its shared mapping
	 * for that version (`AdaptedMembers`); `invalid/member` outside the variant, `contract_mismatch` for a version or
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
		const adapted = this.#adapted?.get(version);
		if (adapted === undefined) return;
		this.#adapted!.delete(version);
		adapted.detach(this.#object.ended());
	}

	/** Its mapping for `version`, made by the first use, reading this instance's own members and provider. */
	#adaptedAt(version: number): AdaptedMembers {
		this.#adapted ??= new Map();
		let adapted = this.#adapted.get(version);
		if (adapted === undefined) {
			const { host, label } = this.#object;
			adapted = new AdaptedMembers(
				{
					served: this.#served,
					variant: this.#variant,
					label,
					batch: host.batch,
					member: (name) => this.member(name),
					report: (member, error) => host.report({ kind: "derive_failed", object: label, member, error }),
				},
				version,
			);
			this.#adapted.set(version, adapted);
		}
		return adapted;
	}

	/** The state member `member`, as Chord follows it; one outside the variant fails `invalid/member`. */
	member(member: string): DeriveSource {
		const source = this.#members!.state.get(member);
		if (source === undefined) {
			throw invalid("member", `${this.#object.label}${this.#inVariant()} has no state member "${member}"`);
		}
		return source;
	}

	/**
	 * Ends the attempt at once (the seal fence): calls, openers and routines aborted with `error` (their callers
	 * rejected with it), its transactions refused and the one holding the line discarded, its job invocations cut off
	 * (an in-memory run ends `aborted` with `runs` as its reason: `reload` for a native restart, slice 7b §8); documents
	 * stay readable.
	 */
	seal(error: ChordError, runs: CutReason = "restart"): void {
		this.abandon({ kind: "ended", error });
		const { documents } = this.#object;
		documents.fence(this.#token);
		for (const job of this.#jobs.values()) job.seal(error, runs);
	}

	/**
	 * Tears a sealed attempt down: waits for its running handlers, routine calls and runs up to the host's
	 * `closeTimeout` (the drain), then closes its natives in reverse with `reason`. Resolves with the closes that threw.
	 */
	async close(reason: NativeCloseReason): Promise<CloseFailed[]> {
		const { host, label } = this.#object;
		if ((await this.#drained()) === "timeout") host.report({ kind: "drain_timeout", object: label });
		// The close writer: the persisted runs the seal stopped, and the held state changes (slice 6b §4.2).
		const handedOver = this.#reloaded?.handedOver === true;
		if (!handedOver) for (const job of this.#jobs.values()) await job.writeAtClose(this.#context);
		// Work stuck past the drain keeps running, but no longer counts as a call or holds its `ctx.get` references.
		cleanUp(this.#running);
		cleanUp(this.#routineRun?.calls);
		if (!handedOver) cleanUp(this.#runs);
		const failures: CloseFailed[] = [];
		for (const native of [...this.#natives].reverse()) {
			const failure = await native.close(reason);
			if (failure !== undefined) failures.push(failure);
		}
		return failures;
	}

	/**
	 * The drain at its end, bounded by `closeTimeout`: its running calls (unless a reload's `drainCalls` waited for them
	 * already), routine calls and job invocations (unless a swap handed its jobs over: they finish on their own).
	 */
	#drained(): Promise<"settled" | "timeout"> {
		const { close } = this.#object.host.timeouts;
		const reloaded = this.#reloaded;
		const running = reloaded?.callsDrained === true ? NO_WORK : this.#running;
		const runs = reloaded?.handedOver === true ? undefined : this.#runs;
		const routineCalls = this.#routineRun?.calls;
		// Most attempts have only calls: no list is made for them.
		if (routineCalls === undefined && runs === undefined) return drained(running.keys(), running.size, close);
		const all = [...running.keys(), ...(routineCalls ?? NO_WORK).keys(), ...(runs ?? NO_WORK).keys()];
		return drained(all, all.length, close);
	}

	/**
	 * Detaches its derives (once their object no longer needs them: reads throw `released`, their watches end), its
	 * followed sources (their observers detached, their watches ended) and its writables (their watches ended).
	 */
	detach(): void {
		const ended = this.#object.ended();
		for (const adapted of this.#adapted?.values() ?? []) adapted.detach(ended);
		this.#adapted = undefined;
		for (const derive of this.#derives) derive.detach(ended);
		for (const follow of this.#follows) follow.detach();
		const declarations = this.#registryDeclarations;
		if (declarations !== undefined) for (const writable of declarations.writables) writable.detach(ended);
	}

	/** Releases its references and registry reads. */
	releaseReferences(): void {
		for (const { binding } of this.#references) binding.release();
		const declarations = this.#registryDeclarations;
		if (declarations !== undefined) for (const release of declarations.reads.splice(0)) release();
	}

	/** The activation steps; each catches its own failures with their kind (the table in slice 2's spec). */
	async #activate(deadline: Deadline): Promise<Activation> {
		let implementation: unknown;
		let dependencies: readonly Dependency[] = NONE;
		try {
			implementation = this.#declare();
			// Right after the factory, before anything can fail: a failed attempt keeps its wake signals.
			this.#object.retryOn(this.#registryDeclarations?.retrySources ?? NONE);
			const { documents } = this.#object;
			// The object holds the pins from now on.
			documents.hydrate(this.#declared, this.#pins.splice(0), this.#opening);
			const loading = documents.load(this.#opening);
			if (loading !== undefined) await loading;
			if (this.#tables.size > 0) await this.#prepareTables(deadline);
			// A persisted job's runs, loaded once per object: rebuilt before anything runs.
			for (const job of this.#jobs.values()) await job.load(this.#opening);
			const { host } = this.#object;
			for (const { binding, contract, params } of this.#references) {
				host.bind(binding, contract, params, this.#opening);
			}
			// Once all are bound: a dependency made here may have bound back to this object meanwhile.
			for (const { binding } of this.#references) {
				const { target } = binding;
				if (target !== undefined) this.#object.assertNoCycle(target, this.#opening);
			}
			// Needed only up to the dependency check: a live attempt keeps none.
			dependencies = this.#dependencies ?? NONE;
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
			const parked = await this.#park(dependencies, deadline);
			if (parked !== undefined) return parked;
		} else {
			this.#settleCheck(undefined);
			// Its own steps start in a later turn: an object ended in the turn it was made opens nothing.
			await undefined;
		}
		return this.#ownSteps(implementation);
	}

	/**
	 * Parks while a dependency is not live (dependency model §3), with no timer: the deadline paused, `parked_long`'s
	 * report the only clock. Checks at every change of a dependency (after its batch) and shows what it found on its
	 * object; once all are live, the keys the factory pinned on them are loaded (a failed load parks it `waiting`
	 * until the next change or a retry). Resolves `undefined` once all are live and pinned, else with how it ends:
	 * abandoned, or broken (a cycle, an ended dependency).
	 */
	async #park(dependencies: readonly Dependency[], deadline: Deadline): Promise<NotLive | undefined> {
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
				const check = checkDependencies(dependencies);
				if (check.kind !== "parked") this.#settleCheck(undefined);
				if (check.kind === "broken")
					return this.#abandoned ?? { kind: "failed", cause: { kind: "broken", error: check.error } };
				if (check.kind === "live") {
					const pinned = await this.#pinKeys(long);
					if (this.#abandoned !== undefined) return this.#abandoned;
					// Changed while the keys loaded: checked again.
					if (pinned === undefined && !this.#moved) {
						// Its own steps follow: `loading` until its outcome (a failure shows as the failure, not this).
						object.unparked(this);
						return undefined;
					}
					if (pinned !== undefined) object.parked(this, pinned, true);
				} else {
					object.parked(this, check.shown, check.firstPass);
					this.#settleCheck(parkedCause(check));
					long.blockedBy(check.blocker);
				}
				if (!(await this.#nextChange())) return this.#abandoned!;
			}
		} finally {
			long.stop();
			for (const release of waits) release();
			this.#parked = undefined;
			object.waitsFor(NONE);
			deadline.resume();
		}
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
	 * Loads the keys the factory pinned on its dependencies' keyed members (`at(key)`), each reference's named to `long`
	 * as the blocker while they load (`failed` when they failed); `undefined` once all are, else what the parked attempt
	 * shows for the first that failed to load (`waiting` on its reference).
	 */
	async #pinKeys(long: ParkedLong): Promise<Failed | undefined> {
		for (const { binding } of this.#references) {
			const { label } = binding;
			try {
				const pinning = binding.pinKeys(this.#opening);
				if (pinning === undefined) continue;
				long.blockedBy({ label, state: "loading" });
				await pinning;
			} catch (error) {
				long.blockedBy({ label, state: "failed" });
				return waitingOn(label, asChordError(error, label));
			}
		}
		return undefined;
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
		for (const dependency of this.#parked ?? NONE) {
			if (dependency.kind === "reference" && dependency.binding.refState.kind === "failed") {
				dependency.binding.retry(walk);
			}
		}
		this.dependencyMoved();
	}

	/**
	 * The steps after the dependency check (its own: natives, followed sources, the member check, derives, the keys
	 * references pin on its keyed members), under the deadline. A dependency that leaves `live` meanwhile changes
	 * nothing (R18 after live).
	 */
	async #ownSteps(implementation: unknown): Promise<Activation> {
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
		let members: Members;
		try {
			const checked = checkImplementation(this.#object.served.contract, implementation);
			members = checked.members;
			this.#members = members;
			this.#variant = checked.variant;
			if (this.#registryDeclarations !== undefined)
				this.#registryDeclarations.contributions = this.#resolveContributions(this.#registryDeclarations);
			const { host, label } = this.#object;
			attachDerives(this.#derives, members.state, (member) => (error) => {
				// During activation a throwing derive fails the attempt, which `activation_failed` reports alone.
				if (!this.#isLive) return;
				host.report({ kind: "derive_failed", object: label, ...(member === undefined ? {} : { member }), error });
			});
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
	async #prepareTables(deadline: Deadline): Promise<void> {
		const handles = [...this.#tables.values()];
		const tables = handles.map(({ definition, sql }) => ({ definition, table: sql.table }));
		const fence = { admit: () => !this.#token.sealed && this.#abandoned === undefined, adopt: () => {} };
		deadline.pause();
		try {
			await prepareTables(tables, handles[0]!.store, fence, this.#object.label, this.#opening);
		} finally {
			deadline.resume();
		}
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
			// A remote object's identity has its principal.
			return served.factory(params, principal!, this);
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

	/** ` (variant reader)` for a remote object, for errors. */
	#inVariant(): string {
		return this.#variant === undefined ? "" : ` (variant ${this.#variant})`;
	}

	#broken(error: unknown): Activation {
		const cause: FailureCause = { kind: "broken", error: asChordError(error, this.#object.label) };
		return this.#abandoned ?? { kind: "failed", cause };
	}

	#declarations(): RegistryDeclarations {
		this.#registryDeclarations ??= {
			reads: [],
			retrySources: [],
			writables: [],
			declared: [],
			contributions: NONE,
		};
		return this.#registryDeclarations;
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
