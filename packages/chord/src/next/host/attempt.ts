// Attempts (§6, §13, §14, §15): one activation of an object, a fresh instance each time. It is the `self` its factory
// declares with (handles to the object's documents and jobs, under its seal token); it runs the activation steps,
// each failing with its own kind; it takes the live object's calls and starts its routines and jobs; and it ends with
// its seal (slice 6a §1.3), the drain and the closes of its natives.

import { awaitWithContext, type Context, withAbortSignal } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { NativeWatchable, Watchable, WatchEnd } from "../../watch.ts";
import type { Contract, Implementation, ParamsOf } from "../contracts/index.ts";
import { contractData, type ShapeOf } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal } from "../data/index.ts";
import { asChordError, checkArgs, checkParams, invalid, openFailure } from "../data/internal.ts";
import type { HandleOf, JsonObject, StateDefinition, Tx } from "../documents/index.ts";
import {
	AddressSource,
	type AnyDefinition,
	type KeyDeclarer,
	type KeyedSlot,
	type KeySource,
	SealToken,
} from "../documents/internal.ts";
import type { JobDefinition, JobHandle, JobImplementation } from "../jobs/index.ts";
import { type AnyJobImplementation, Job } from "../jobs/internal.ts";
import type { Contribution, Registry, RegistryValue } from "../registries/index.ts";
import {
	type RegistryContribution,
	type RegistryEdge,
	RegistryValueSource,
	type RegistryWaiter,
} from "../registries/internal.ts";
import type { Writable } from "../state/index.ts";
import { Derive, type DeriveSource, WritableSource } from "../state/internal.ts";
import type { Columns } from "../store/columns.ts";
import { tableSqlName } from "../store/sql.ts";
import type { ChordStore } from "../store/store.ts";
import type { TableDefinition } from "../store/table.ts";
import { type Table, TableHandle } from "../store/table-handle.ts";
import { prepareTables } from "../store/table-migration.ts";
import { CallContext, type Caller, type Ctx, withLinkedAbortSignal } from "./ctx.ts";
import { Deadline } from "./deadline.ts";
import { checkDependencies, type Dependency, ParkedLong, waitingOn } from "./dependencies.ts";
import { type FollowAttach, FollowSource } from "./follow.ts";
import type { HostError } from "./host.ts";
import { attachDerives, checkImplementation, contributionOf, type KeyedBinding, type Members } from "./members.ts";
import {
	type CloseFailed,
	drained,
	type Native,
	type NativeCloseReason,
	NativeHandle,
	type NativeOptions,
	type NativeSlot,
} from "./native.ts";
import type { ChordObject } from "./object.ts";
import type { Failed } from "./ref-state.ts";
import type { Binding, CheckedParams, Reference, RetryOperation } from "./reference.ts";
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

/**
 * A factory: synchronous and declarative, run once per attempt. A remote one also gets the principal in its object's
 * identity and returns one variant, `{ variant, members }`. Methods get a `Ctx` for the app's principal type `P`.
 */
export type Factory<C extends Contract, P extends Principal = Principal> = ShapeOf<C>["kind"] extends "local"
	? (params: ParamsOf<C>, self: keyof ParamsOf<C> extends never ? StoreSelf<P> : Self<P>) => Implementation<C, Ctx<P>>
	: (params: ParamsOf<C>, principal: P, self: Self<P>) => Implementation<C, Ctx<P>>;

/** No declarations of a kind: the shared empty list. */
const NONE: readonly never[] = [];

/** An attempt's registry reads, contributions and wake signals, and its writables (slice 8). */
type RegistryDeclarations = {
	/** The registry values it declared (`self.registry`): dependencies, as its references are. */
	readonly registries: RegistryValueSource[];
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
	/** The object's context: the natives' closes run under it. */
	readonly #context: Context;
	/** Aborted when the attempt is abandoned or ends: openers, activation's waits and calls run under its signal. */
	readonly #abort = new AbortController();
	/** The object's context under this attempt's signal. */
	readonly #opening: Context;
	/** The seal token its handles and transactions carry (the seal fence). */
	readonly #token = new SealToken();
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
	readonly #natives: NativeSlot[] = [];
	/**
	 * Running calls' handlers, routine calls and job runs, each with its bookkeeping (call counts, `ctx.get`
	 * references): an ending attempt waits for them (the drain); the bookkeeping runs once, when its work settles or at
	 * teardown for work stuck past the drain (decision "The seal fence" (4)). One map and one reaction per piece of work:
	 * the call path costs no more than before the cleanups.
	 */
	readonly #running = new Map<Promise<unknown>, (() => void) | undefined>();
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

	constructor(object: ChordObject, context: Context) {
		this.#object = object;
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
		// The binding was built from `Type`'s members.
		return binding.reference as Reference<C>;
	}

	registry<C, V>(R: Registry<C, V>): RegistryValue<V> {
		this.#assertDeclaring("registry");
		const value = this.#object.host.registryRecord(R.name).value(R.version);
		this.#declarations().registries.push(value);
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
		const { served, label, host } = this.#object;
		// R21: the types allow it only to host-lifetime objects; plugin code is bundled without type checks.
		if (served.kind !== "local" || !served.hostLifetime) {
			throw new Error(`${label}: self.contribute is valid only in a local type with empty params`);
		}
		const { declared } = this.#declarations();
		if (declared.some(({ registry }) => registry.name === R.name)) {
			throw new Error(`${label}: registry ${R.name} is contributed to twice`);
		}
		// Refused at `contribute` (declaration policy), also a cycle within this factory's own declarations; the edges
		// live with the contributions in the tables, from live on.
		if (value instanceof RegistryValueSource) host.registryRecord(R.name).assertNoCycle(value, this.#pendingEdges());
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
			admit: (running: Promise<unknown>, cleanup?: () => void) => this.#admit(running, cleanup),
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
		}
	}

	/** Abandons the activation with `outcome` (once): its waits stop and the openers' contexts are aborted. */
	abandon(outcome: NotLive): void {
		if (this.#abandoned !== undefined) return;
		this.#abandoned = outcome;
		this.#abort.abort(outcome.kind === "ended" ? outcome.error : outcome.cause.error);
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

	/** The object went live: its jobs take starts and its routines start, in this turn; both stop when it is sealed. */
	live(): void {
		this.#isLive = true;
		const early = this.#endedEarly;
		if (early !== undefined) {
			this.#object.failLive(this, { kind: "transient", error: early });
			return;
		}
		for (const job of this.#jobs.values()) job.live();
		const { host, label } = this.#object;
		this.#routines.start({
			label,
			host,
			caller: this.#caller(),
			context: this.#opening,
			admit: (running, cleanup) => this.#admit(running, cleanup),
		});
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
	 * Calls a method for `caller`: a method outside the variant fails `invalid/member` first, then the arguments are
	 * checked against the current version (L1); the handler runs under a ctx aborted by the caller and by this attempt's
	 * end. Either rejects the caller at once; the handler runs on, its transactions refused, and the drain waits for it.
	 * Its `ctx.get` references are released when it settles.
	 */
	async call(method: string, args: unknown, context: Context, caller: Caller): Promise<unknown> {
		context.abortSignal?.throwIfAborted();
		const { host, served, label } = this.#object;
		const handler = this.#members!.methods.get(method);
		if (handler === undefined) throw invalid("member", `${label}${this.#inVariant()} has no method "${method}"`);
		const checked = checkArgs(served.provider, method, args, served.contract.version, context);
		const linked = withLinkedAbortSignal(this.#abort.signal, context);
		const callContext = linked.context;
		// A local object's handlers act as the host, its principal and its incarnation (§4); a remote one's as their
		// caller. The caller stays the reference's (presence, §19).
		const acting = served.kind === "remote" ? caller : { principal: host.principal, incarnation: host.incarnation };
		const ctx = new CallContext(callContext, acting, host);
		// Admitted to the drain before the handler runs: the handler may end its own object before it returns.
		const running = Promise.withResolvers<unknown>();
		host.count("calls", 1);
		this.#admit(running.promise, () => {
			host.count("calls", -1);
			linked.release();
			ctx.settle();
		});
		// Plugin code, not type-checked: a synchronous throw or a plain value becomes the promise.
		(async () => handler(checked.args, ctx))().then(running.resolve, running.reject);
		return awaitWithContext(running.promise, callContext);
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
	 * Whether `source` (a state member) changes only through this object's own commits: one of this attempt's derives,
	 * or one of the object's documents. Another object's member source or document is foreign.
	 */
	owns(source: DeriveSource): boolean {
		if (source instanceof Derive) return this.#derives.includes(source);
		return source instanceof AddressSource && source.owner === this.#object.documents;
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
	 * rejected with it), its transactions refused and the one holding the line discarded, its job invocations cut off;
	 * documents stay readable.
	 */
	seal(error: ChordError): void {
		this.abandon({ kind: "ended", error });
		this.#object.documents.fence(this.#token);
		for (const job of this.#jobs.values()) job.seal(error);
	}

	/**
	 * Tears a sealed attempt down: waits for its running handlers, routine calls and runs up to the host's
	 * `closeTimeout` (the drain), then closes its natives in reverse with `reason`. Resolves with the closes that threw.
	 */
	async close(reason: NativeCloseReason): Promise<CloseFailed[]> {
		const { host, label } = this.#object;
		if ((await drained(this.#running.keys(), this.#running.size, host.timeouts.close)) === "timeout") {
			host.report({ kind: "drain_timeout", object: label });
		}
		// The close writer: the persisted runs the seal stopped, and the held state changes (slice 6b §4.2).
		for (const job of this.#jobs.values()) await job.writeAtClose(this.#context);
		// Work stuck past the drain keeps running, but no longer counts as a call or holds its `ctx.get` references.
		for (const [running, cleanup] of this.#running) {
			this.#running.delete(running);
			cleanup?.();
		}
		const failures: CloseFailed[] = [];
		for (const native of [...this.#natives].reverse()) {
			const failure = await native.close(reason);
			if (failure !== undefined) failures.push(failure);
		}
		return failures;
	}

	/**
	 * Detaches its derives (once their object no longer needs them: reads throw `released`, their watches end), its
	 * followed sources (their observers detached, their watches ended) and its writables (their watches ended).
	 */
	detach(): void {
		const ended = this.#object.ended();
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
		const dependencies: Dependency[] = [];
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
				dependencies.push({ kind: "reference", binding });
			}
			// Once all are bound: a dependency made here may have bound back to this object meanwhile.
			for (const dependency of dependencies) {
				const target = dependency.kind === "reference" ? dependency.binding.target : undefined;
				if (target !== undefined) this.#object.assertNoCycle(target, this.#opening);
			}
			const declarations = this.#registryDeclarations;
			for (const value of declarations?.registries ?? NONE) {
				// Read from here until its references are released: an older version's mapping is kept meanwhile.
				declarations?.reads.push(value.read());
				dependencies.push({ kind: "registry", value });
			}
		} catch (error) {
			return this.#broken(error);
		}
		// Parked only when something is not live yet (most activations find their dependencies live).
		if ((dependencies.length > 0 && checkDependencies(dependencies).kind !== "live") || this.#pinsKeys()) {
			const parked = await this.#park(dependencies, deadline);
			if (parked !== undefined) return parked;
		} else {
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
				if (check.kind === "broken")
					return this.#abandoned ?? { kind: "failed", cause: { kind: "broken", error: check.error } };
				if (check.kind === "live") {
					const pinned = await this.#pinKeys();
					if (this.#abandoned !== undefined) return this.#abandoned;
					// Changed while the keys loaded: checked again.
					if (pinned === undefined && !this.#moved) {
						// Its own steps follow: `loading` until its outcome (a failure shows as the failure, not this).
						object.unparked(this);
						return undefined;
					}
					if (pinned !== undefined) object.parked(this, pinned, true);
					long.stop();
				} else {
					object.parked(this, check.shown, check.firstPass);
					long.waitingOn(check.remoteLoading);
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
	 * Loads the keys the factory pinned on its dependencies' keyed members (`at(key)`); `undefined` once all are, else
	 * what the parked attempt shows for the first that failed to load (`waiting` on its reference).
	 */
	async #pinKeys(): Promise<Failed | undefined> {
		for (const { binding } of this.#references) {
			try {
				const pinning = binding.pinKeys(this.#opening);
				if (pinning !== undefined) await pinning;
			} catch (error) {
				return waitingOn(binding.label, asChordError(error, binding.label));
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
	 * transient one retries, a parked one passes it on, a request waiting in an index is left alone), as `operation`;
	 * then it checks again (a key that failed to load is loaded again).
	 */
	retryDependencies(operation: RetryOperation): void {
		for (const dependency of this.#parked ?? NONE) {
			if (dependency.kind === "reference" && dependency.binding.refState.kind === "failed") {
				dependency.binding.retry(operation);
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
		try {
			// The keys references pin on the object's keyed members, loaded on this attempt's before it goes live.
			const preparing = this.#object.prepareKeys(members.keyed, this.#opening);
			if (preparing !== undefined) await preparing;
		} catch (error) {
			const cause: FailureCause = { kind: "transient", error: asChordError(error, this.#object.label) };
			return this.#abandoned ?? { kind: "failed", cause };
		}
		return this.#abandoned ?? { kind: "live" };
	}

	/** Its declared contributions, as Chord follows them (its references are live now), by its plugin and type. */
	#resolveContributions({ declared }: RegistryDeclarations): readonly RegistryContribution[] {
		const { served, host } = this.#object;
		const contributor = { plugin: served.plugin, type: served.contract.name };
		const pending = this.#pendingEdges();
		return declared.map(({ registry, value }) =>
			contributionOf(host.registryRecord(registry.name), contributor, registry.version, value, pending),
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

	/** Adds `running` to the drain, with `cleanup` run once: when it settles, or at teardown if it never does. */
	#admit(running: Promise<unknown>, cleanup?: () => void): void {
		this.#running.set(running, cleanup);
		// Out of the map already: the teardown ran the cleanup.
		const settled = (): void => {
			if (this.#running.delete(running)) cleanup?.();
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

	/** The registry edges its declared contributions would add (another registry's value contributed). */
	#pendingEdges(): RegistryEdge[] {
		const edges: RegistryEdge[] = [];
		const { host } = this.#object;
		for (const { registry, value } of this.#registryDeclarations?.declared ?? NONE) {
			const to = value instanceof RegistryValueSource ? value.record : undefined;
			if (to !== undefined) edges.push({ from: host.registryRecord(registry.name), to });
		}
		return edges;
	}

	#declarations(): RegistryDeclarations {
		this.#registryDeclarations ??= {
			registries: [],
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
