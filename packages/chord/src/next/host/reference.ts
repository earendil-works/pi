// References (§7): what `get` and `hold` return, a plain object built from the contract's members, and its binding to
// the object: counted as a reference, it follows the object's state, parks calls while loading, keeps the
// per-reference watches and is released once. A binding whose object a reload removed, or whose version it no longer
// binds, waits unbound and binds again (slice 7b §6); one of an older version reads adapted members (Q10).

import { BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { NativeWatchable, Watch, Watchable } from "../../watch.ts";
import type { Contract, Implementation, ParamsOf } from "../contracts/index.ts";
import {
	type CurrentVariants,
	currentVariants,
	LOCAL,
	type MethodData,
	type ShapeOf,
	takesNoArgs,
	type VariantImplementation,
} from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal } from "../data/index.ts";
import { Keyed, type KeyedSlot, type SealToken, Singleton } from "../documents/internal.ts";
import { RETRY_HOPS } from "../link/internal.ts";
import { type Batch, Constant, type DeriveSource, Source } from "../state/internal.ts";
import type { PinnedKey } from "./attempt.ts";
import { type Caller, withLinkedAbortSignal } from "./ctx.ts";
import type { KeyedBinding } from "./members.ts";
import type { ChordObject, Holder, Removal } from "./object.ts";
import { ParkedCalls } from "./parked.ts";
import { type Ended, type Failed, LOADING, ReferenceState, type RefState } from "./ref-state.ts";
import { ReferenceKeys } from "./reference-keys.ts";
import { ReferenceSource } from "./reference-source.ts";
import type { UnboundRequest } from "./unbound.ts";

/**
 * A reference: a local contract's members, or for a remote contract the members of the variant its object chose,
 * narrowed by `variant`; and its state, `retry()` and `release()`. Every use after release throws.
 */
export type Reference<C extends Contract> = ShapeOf<C>["kind"] extends "local"
	? Implementation<C> & Lifecycle
	: InVariants<C, never>;

/** What `host.hold` returns: a reference whose `variant` is `undefined` until its first binding. */
export type Held<C extends Contract> = ShapeOf<C>["kind"] extends "local"
	? Implementation<C> & Lifecycle
	: InVariants<C, undefined>;

/** A remote reference narrowed to some of its variants. */
export type RefIn<C extends Contract, V extends string> = Extract<Reference<C>, { readonly variant: V }>;

/** One member of a remote reference's union per variant; `Unbound` is what `variant` may also be. */
type InVariants<C extends Contract, Unbound> = {
	[V in keyof CurrentVariants<C>]: { readonly variant: V | Unbound } & VariantImplementation<CurrentVariants<C>[V]> &
		Lifecycle;
}[keyof CurrentVariants<C>];

/** What every reference has besides its members. */
type Lifecycle = {
	/** The reference's state: loading, live, failed or released; watches get every change. */
	readonly state: NativeWatchable<RefState>;
	/**
	 * Asks a failed object for an attempt now (the backoff skipped, a broken one renewed); an object parked on failed
	 * dependencies passes it on to them, once; otherwise nothing.
	 */
	retry(): void;
	release(): void;
};

/**
 * What a binding is bound to: an object on this host (`ChordObject`), or an object held over a path, the parent link
 * or a route address (`RemoteObject`). It tells its holders of each change of `state`.
 */
export interface Target {
	/** The object in errors: its type, and its params key when it has params. */
	readonly label: string;
	/** Its state as its references show it. */
	readonly state: RefState;
	/** Whether its state members have values: live once, for a remote object bound once. */
	readonly hydrated: boolean;
	/** The variant bound last; `undefined` for a local object and before the first binding. */
	readonly variant: string | undefined;
	/** The error of its last failure (an attempt's, or the dependencies it is parked on) while none went live since. */
	readonly lastFailure: ChordError | undefined;
	/** Its instance id while it activates on this host (Q5); `undefined` otherwise and over a link. */
	readonly activationId: string | undefined;
	/**
	 * Whether it holds up this host's start barrier: an object here without its first outcome (decision (a)); a remote
	 * object never does.
	 */
	readonly blocksFirstPass: boolean;
	/** Counts `binding` as a reference; the binding reads `state` itself. */
	hold(binding: Binding): void;
	/** `binding` was released. */
	unhold(binding: Binding): void;
	/** Calls a method of the live object for `caller`, bound at `version` (an older one is mapped, Q10). */
	call(method: string, args: unknown, context: Context, caller: Caller, version: number): Promise<unknown>;
	/**
	 * What a reference of `version` follows for state member `member` now (decision "References are the only
	 * indirection"): the live instance's member (a replica over a link), or nothing (`loading`, or `failed` with the
	 * cause's error), with the member a reference takes its last value from.
	 */
	followed(member: string, version: number): Followed;
	/** The instance its references follow now (they attach to it); `undefined` once it stopped changing. */
	readonly attachable: Attachable | undefined;
	/** Its live instance (a reference's keys pin there; a new one, they pin again); `undefined` when not live. */
	readonly instance: unknown;
	/** The keyed member `member` of the live object: its ultimate slot (slice 6a §12; only local objects have any). */
	keyedMember(member: string): KeyedSlot;
	/**
	 * How a consumer of `version` reads keyed member `member`'s documents: mapped back to its version when older
	 * (slice 7b §7), `undefined` when as they are; `contract_mismatch` when the provider refuses it.
	 */
	keyedMapping(member: string, version: number): ((current: JsonValue) => JsonValue) | undefined;
	/**
	 * Pins `key` of keyed member `member` on the live instance, loaded, as a consumer of `version` reads it (mapped when
	 * older); only a live local object has keyed members.
	 */
	pinKey(member: string, key: string, version: number, context: Context): Promise<PinnedKey>;
	/**
	 * `ref.retry()`, as one step of `walk`: an attempt now if failed; an object parked on failed dependencies passes it
	 * on; ignored otherwise.
	 */
	retry(walk: RetryWalk): void;
	/**
	 * The chain of activation waits from this object to `target`, both included (Q5); `undefined` when there is none.
	 * `visited` keeps a search over shared dependencies linear in the waits.
	 */
	pathTo(target: ChordObject, visited: Set<Target>): ChordObject[] | undefined;
}

/** An instance a reference attaches to (`Target.attachable`): it keeps last values in that instance's variant. */
export type Attachable = { readonly variant: string | undefined };

/**
 * What a reference follows of its target for one state member (`Target.followed`): the member of the instance it
 * follows (`instance`, still changing), a member its live variant lacks (`invalid/member`), or nothing: its target loads
 * (no call) or failed (one `failed` call with the cause's error); `last` is the member of `instance`, which stopped
 * changing, that a reference attached to it takes a last value from (never one it never attached to).
 */
export type Followed =
	| { readonly kind: "live"; readonly source: DeriveSource; readonly instance: unknown }
	| { readonly kind: "lacking"; readonly error: ChordError }
	| { readonly kind: "loading"; readonly last: DeriveSource | undefined; readonly instance: unknown }
	| {
			readonly kind: "failed";
			readonly error: ChordError;
			readonly last: DeriveSource | undefined;
			readonly instance: unknown;
	  };

/**
 * One retry's walk through parked objects on this host (dependency model §3.7, audit A5): the objects it reached (one
 * reached again, through a diamond, ignores it) and the hop budget a `retry` message to another host carries (none is
 * sent at 0, so a waiting ring of hosts stops).
 */
export type RetryWalk = { readonly visited: Set<ChordObject>; readonly hops: number };

/** A walk starting here: `ref.retry()`'s, with the first host's budget, or a `retry` message's, with one hop less. */
export function retryWalk(hops = RETRY_HOPS): RetryWalk {
	return { visited: new Set(), hops };
}

/** A reference's params as L1 checked them, with their identity key. */
export type CheckedParams = { readonly params: ParamsOf<Contract>; readonly key: string };

/**
 * Where a binding stands. `unbound`: waiting for its object's activation to bind it (a `self.get`); `waiting`: in the
 * host's unbound index, `place` checking it again when woken: before the publication (no `failure`: `loading`), or after
 * a check that found no fitting provider (`failed { waiting }`, `not_served` or `version`); `refused`: a broken refusal
 * (a `hostAddress` or `authorize` that threw or refused) until `ref.retry()` places it again; a released binding keeps
 * nothing but its name and its end (`ref.state`'s `ended`). `dependent` is the object whose attempt declared the
 * reference with `self.get`, `undefined` for `host.get`, `host.hold` and `ctx.get`.
 */
type BindingState =
	| {
			readonly kind: "unbound";
			readonly batch: Batch;
			readonly dependent: ChordObject | undefined;
	  }
	| {
			readonly kind: "bound";
			readonly batch: Batch;
			readonly dependent: ChordObject | undefined;
			readonly target: Target;
	  }
	| {
			readonly kind: "waiting";
			readonly batch: Batch;
			readonly dependent: ChordObject | undefined;
			readonly failure: Failed | undefined;
			readonly place: () => void;
			/** Takes it out of the index (it ended). */
			readonly leave: () => void;
	  }
	| {
			readonly kind: "refused";
			readonly batch: Batch;
			readonly dependent: ChordObject | undefined;
			readonly failure: Failed;
			readonly bind: () => void;
	  }
	| { readonly kind: "released"; readonly state: Ended };

/** What a wait for a state decides at each change. */
type Decision =
	| { readonly kind: "wait" }
	| { readonly kind: "done" }
	| { readonly kind: "failed"; readonly error: unknown };

const WAIT: Decision = { kind: "wait" };

const DONE: Decision = { kind: "done" };

/** A wait for a state: checked at every change, rejected with the reference's end. */
type Waiter = { readonly check: () => void; readonly end: (error: ChordError) => void };

/**
 * A reference's binding to its object: counted by the object as one of its references while bound, and told of each
 * change of its state. Calls run while live, park while loading (sent in order once live) and reject while failed.
 * Released, or ended with its object, it ends the watches taken through it and rejects the calls made through it.
 */
export class Binding implements Holder, UnboundRequest {
	readonly reference: Reference<Contract>;
	/** Who calls through this reference: the principal it was got as, and this host's incarnation. */
	readonly caller: Caller;
	/** The contract's name, for errors. */
	readonly #name: string;
	/** The consumer's contract (its version is the binding's) until the reference is released (it keeps none then). */
	#contract: Contract | undefined;
	/** How long a call made while loading waits: the reference's `readyTimeout`. */
	readonly #parkTimeout: number;
	#state: BindingState;
	readonly #watches = new Set<Watch<JsonValue>>();
	/**
	 * Aborted when the reference ends: its calls' callers are rejected and their handlers' contexts aborted. Made by the
	 * first call and dropped at the end, so a released reference keeps no error (whose stack keeps its frames).
	 */
	#calls: AbortController | undefined;
	/** Calls made while loading; made by the first. */
	#parked: ParkedCalls | undefined;
	/** Waits for a state (getters, member watches before the first binding); each checks the state at every change. */
	readonly #waiters = new Set<Waiter>();
	/** `ref.state`, made on first access. */
	#refState: ReferenceState | undefined;
	/** The keys its object's factory pinned with `ref.member.at(key)`: pinned once bound, released with it. */
	readonly #ats: KeyedMemberAt[] = [];
	/** Its state members as consumers follow them (`ReferenceSource`), by name; each made by its first use. */
	#sources: Map<string, ReferenceSource> | undefined;
	/** The keys of its object's keyed members it holds (key watches, `at(key)` pins); made by the first. */
	#heldKeys: ReferenceKeys | undefined;
	/** The instance it attached to last: it takes last values only from that one (never one it never followed). */
	#attached: Attachable | undefined;

	constructor(
		contract: Contract,
		batch: Batch,
		dependent: ChordObject | undefined,
		caller: Caller,
		parkTimeout: number,
	) {
		this.#name = contract.name;
		this.#contract = contract;
		this.caller = caller;
		this.#parkTimeout = parkTimeout;
		this.#state = { kind: "unbound", batch, dependent };
		const reference: Record<string, unknown> = { release: () => this.release(), retry: () => this.retry() };
		Object.defineProperty(reference, "state", { get: () => this.#watchableState(), enumerable: true });
		// Every member of every variant (one kind and signature per name, D11); the bound variant decides which work.
		const methods = new Map<string, MethodData>();
		for (const variant of currentVariants(contract).values()) {
			for (const member of variant.state.keys()) reference[member] = new ReferenceMember(this, member);
			for (const member of variant.keyed.keys()) reference[member] = new ReferenceKeyed(this, member);
			for (const [member, method] of variant.methods) methods.set(member, method);
		}
		for (const [member, method] of methods) {
			// A method without arguments omits them; `null` is their internal and wire form.
			reference[member] = takesNoArgs(method)
				? async (context: Context) => this.#call(member, null, context)
				: async (args: unknown, context: Context) => this.#call(member, args, context);
		}
		if (contract.kind === "remote") {
			Object.defineProperty(reference, "variant", { get: () => this.#variant(), enumerable: true });
		}
		// Built from the contract's own member lists.
		this.reference = reference as Reference<Contract>;
	}

	/** The consumer's contract: its version is the binding's. Only an unreleased binding is asked. */
	get contract(): Contract {
		return this.#contract!;
	}

	/** The object whose attempt declared this reference, until it is released. */
	get dependent(): ChordObject | undefined {
		const state = this.#state;
		return state.kind === "released" ? undefined : state.dependent;
	}

	/** Whom it acts for (the unbound index's revocation). */
	get principal(): Principal | undefined {
		return this.caller.principal;
	}

	/** The reference's state. */
	get refState(): RefState {
		const state = this.#state;
		if (state.kind === "bound") return state.target.state;
		if (state.kind === "waiting") return state.failure ?? LOADING;
		if (state.kind === "refused") return state.failure;
		return state.kind === "unbound" ? LOADING : state.state;
	}

	/** The object it is bound to; `undefined` while it is not bound. */
	get target(): Target | undefined {
		return this.#state.kind === "bound" ? this.#state.target : undefined;
	}

	/** The object in errors: its label once bound, else the contract's name. */
	get label(): string {
		return this.#state.kind === "bound" ? this.#state.target.label : this.#name;
	}

	/** The error of the object's last failure while none went live since, or of the check that left it unbound. */
	get lastFailure(): ChordError | undefined {
		const state = this.#state;
		if (state.kind === "refused") return state.failure.cause.error;
		if (state.kind === "waiting") return state.failure?.cause.error;
		return state.kind === "bound" ? state.target.lastFailure : undefined;
	}

	/**
	 * Binds to `target`, which counts this binding as a reference; its members and keys follow what `target` shows now
	 * (one frame from their last values), and the reference takes its state.
	 */
	bind(target: Target): void {
		const state = this.#state;
		if (state.kind !== "unbound") return;
		this.#state = { kind: "bound", batch: state.batch, dependent: state.dependent, target };
		target.hold(this);
		// `hold` may release it at once (a presence derive): `retarget` sees that. A batch only when members move.
		if (this.following) state.batch.within(() => this.retarget(), BACKGROUND_CONTEXT);
		else this.retarget();
		this.moved();
	}

	/** Whether its members or keys were used: `retarget` moves them (in a batch). */
	get following(): boolean {
		return this.#sources !== undefined || this.#heldKeys !== undefined;
	}

	/**
	 * Inside a batch when `following`: its members and keys follow what its object shows now (`Target.followed`): the live instance's
	 * members (moved there, one frame each), or their last values (one `failed` call for a failure). The first time it
	 * points at nothing, every member of its version gets its last value, read or not.
	 */
	retarget(): void {
		const state = this.#state;
		if (state.kind !== "bound") return;
		const { target } = state;
		const { version } = this.contract;
		const attachable = target.attachable;
		if (attachable !== undefined) this.#attached = attachable;
		// Detaching from an instance it attached to: every member keeps its last value (none before it ever attached).
		else if (this.#attached !== undefined) this.#keepAll(this.#attached);
		const attached = this.#attached;
		for (const [member, source] of this.#sources ?? []) place(source, target.followed(member, version), attached);
		// Its last values taken: it keeps no node of that instance (GC).
		if (attachable === undefined) this.#attached = undefined;
		this.#heldKeys?.follow(BACKGROUND_CONTEXT);
	}

	/**
	 * Its object left it (slice 7b §6): its type was removed, or its provider no longer binds its version. The request
	 * waits unbound with `removal.cause` in the host's index, its members and keys keeping their last values (taken from
	 * the instance it leaves; one `failed` call), and binds again, by name, when a publication serves it: its members
	 * move to the next object's instance and its keys pin there again (one frame each); parked calls flush or reject;
	 * presence lists it again.
	 */
	removed(removal: Removal): void {
		const state = this.#state;
		if (state.kind !== "bound") return;
		const { error } = removal.cause;
		state.batch.within(() => {
			// Its last values from the instance it attached to (one refused at its binding attached to none).
			if (this.#attached !== undefined) this.#keepAll(this.#attached);
			for (const source of this.#sources?.values() ?? []) source.fail(error, BACKGROUND_CONTEXT);
			this.#heldKeys?.fail(error, BACKGROUND_CONTEXT);
		}, BACKGROUND_CONTEXT);
		// Its last values taken: it keeps no node of that instance (GC).
		this.#attached = undefined;
		this.#state = { kind: "unbound", batch: state.batch, dependent: state.dependent };
		removal.host.rewait(this, this.contract, removal.params, removal.cause, removal.context);
	}

	/**
	 * Every state member of its version, in the variant of the instance it attached to (its object may be live no more),
	 * gets a source, read or not, so each keeps a last value while it points at nothing (no-op for one already made).
	 */
	#keepAll(attached: Attachable): void {
		const variant = currentVariants(this.contract).get(attached.variant ?? LOCAL);
		for (const member of variant?.state.keys() ?? []) this.#memberSource(member);
	}

	/**
	 * Leaves the reference unbound in the host's unbound index (`leave` takes it out): `loading` before the publication
	 * (no `cause`), else `failed` with `cause` (`waiting`); `place` checks it again when the index wakes it.
	 */
	wait(cause: FailureCause | undefined, place: () => void, leave: () => void): void {
		const state = this.#state;
		if (state.kind !== "unbound") return;
		// Kept while it waits: its stack made text now, so it keeps none of the frames' objects (an ended instance's).
		if (cause !== undefined) void cause.error.stack;
		const failure: Failed | undefined =
			cause === undefined ? undefined : { kind: "failed", cause, retryAt: undefined };
		const { batch, dependent } = state;
		this.#state = { kind: "waiting", batch, dependent, failure, place, leave };
		// Unchanged while loading: nothing to tell.
		if (failure !== undefined) this.moved();
	}

	/** Woken by the unbound index (out of it already): checked again where it goes. */
	wake(): void {
		const state = this.#state;
		if (state.kind !== "waiting") return;
		const { batch, dependent } = state;
		this.#state = { kind: "unbound", batch, dependent };
		state.place();
	}

	/**
	 * A reference that cannot be bound (where it goes refused it): failed broken with `cause` until `ref.retry()` runs
	 * `bind` again (a route's `authorize` may admit it later).
	 */
	refuse(cause: FailureCause, bind: () => void): void {
		const state = this.#state;
		if (state.kind !== "unbound") return;
		const failure: Failed = { kind: "failed", cause, retryAt: undefined };
		this.#state = { kind: "refused", batch: state.batch, dependent: state.dependent, failure, bind };
		this.moved();
	}

	/**
	 * The state may have changed: `ref.state`'s watches are told; live sends the parked calls in order, failed
	 * rejects them with the cause; waits for a state decide; the object whose attempt declared it re-evaluates.
	 */
	moved(): void {
		this.#refState?.moved();
		const state = this.refState;
		if (state.kind === "live") {
			this.#parked?.flush(
				(method, args, context) => this.#send(method, args, context),
				() => this.refState.kind === "live",
			);
		} else if (state.kind === "failed") {
			this.#parked?.reject(state.cause.error);
		}
		for (const waiter of [...this.#waiters]) waiter.check();
		this.dependent?.dependencyMoved();
	}

	/** Resolves when the reference is live; rejects with a broken failure's error, or its end. Getters wait for it. */
	live(context: Context): Promise<void> {
		return this.#until((state) => {
			if (state.kind === "live") return DONE;
			const broken = state.kind === "failed" && state.cause.kind === "broken";
			return broken ? { kind: "failed", error: state.cause.error } : WAIT;
		}, context);
	}

	/**
	 * The state member behind `member`, as consumers follow it (`ReferenceSource`): the instance's member while its
	 * object is live, its last value while it points at nothing; reads throw `released`, the failure's error, or
	 * `not_ready` when it never had a value.
	 */
	member(member: string): DeriveSource {
		return this.#memberSource(member);
	}

	/** The source of state member `member`, made by its first use, following what its target shows now. */
	#memberSource(member: string): ReferenceSource {
		this.#sources ??= new Map();
		let source = this.#sources.get(member);
		if (source !== undefined) return source;
		const state = this.#state;
		// A released reference throws its end (`#target`): it makes no source.
		if (state.kind === "released") throw state.state.error;
		source = new ReferenceSource(state.batch, this);
		this.#sources.set(member, source);
		// New, nothing follows it yet: placing it needs no batch.
		if (state.kind === "bound") place(source, state.target.followed(member, this.contract.version), this.#attached);
		return source;
	}

	/** What a read of a member that never had a value throws: `released`, the failure's error, or `not_ready`. */
	none(): ChordError {
		try {
			this.#target();
		} catch (error) {
			return error as ChordError;
		}
		return new ChordError({ code: "not_ready", message: `${this.label}: not live yet` });
	}

	/** The keyed member `member`'s slot (slice 6a §12), as `member` resolves a state member. */
	keyedSlot(member: string): KeyedSlot {
		return this.#target().keyedMember(member);
	}

	/** How this reference reads keyed member `member`'s documents (`Target.keyedMapping`), as `keyedSlot` resolves. */
	keyedMapping(member: string): ((current: JsonValue) => JsonValue) | undefined {
		return this.#target().keyedMapping(member, this.contract.version);
	}

	/**
	 * Holds `key` of keyed member `member` (a key watch, a factory's `at(key)`, an object re-exposing this member): its
	 * source, pinned on the live instance and following its object's instances (`ReferenceKeys`); `release` once.
	 */
	pinKey(member: string, key: string, context: Context): Promise<PinnedKey> {
		const state = this.#state;
		if (state.kind === "released") return Promise.reject(state.state.error);
		this.#heldKeys ??= new ReferenceKeys({
			batch: state.batch,
			version: this.contract.version,
			target: () => this.target,
			none: () => this.none(),
		});
		return this.#heldKeys.hold(member, key, context);
	}

	/** The bound object unless it failed: throws `released`, the failure's error, `not_ready` before the binding. */
	#target(): Target {
		const state = this.#state;
		switch (state.kind) {
			case "bound": {
				const current = state.target.state;
				if (current.kind === "failed") throw current.cause.error;
				return state.target;
			}
			case "unbound":
				throw new ChordError({ code: "not_ready", message: `${this.#name}: not live yet` });
			case "waiting":
				if (state.failure === undefined) {
					throw new ChordError({ code: "not_ready", message: `${this.#name}: not live yet` });
				}
				throw state.failure.cause.error;
			case "refused":
				throw state.failure.cause.error;
			case "released":
				throw state.state.error;
		}
	}

	/**
	 * A watch of `member` that ends when this reference is released, through its member (`ReferenceSource`): opened at
	 * once once it has a value (its last one while its object is not live, frames again when it is); before its first
	 * value it waits for its object's (`firstValues`: through failures, until the reference ends or `context` aborts).
	 */
	async watch(member: string, context: Context): Promise<Watch<JsonValue>> {
		// Checked here too: a constant's own watch has no batch to check. A released reference throws below.
		if (this.#state.kind !== "released") this.#state.batch.assertOutside("watch");
		const source = this.#memberSource(member);
		// Never had a value: it waits for its object's, as before the first binding.
		if (source.unbound) await this.firstValues(context);
		return this.follow(source.openWatch(context));
	}

	/**
	 * Resolves once its object's members have values (its first binding, for a watch on a reference that never had any);
	 * rejects only when the reference ends (released, revoked, its host closed) or `context` aborts: a failure is waited
	 * through (Opus G3).
	 */
	async firstValues(context: Context): Promise<void> {
		if (this.#state.kind === "bound" && this.#state.target.hydrated) return;
		await this.#until((state) => (state.kind === "live" ? DONE : WAIT), context);
	}

	/** Resolves once the object's members have values; rejects when the reference fails or is released first. */
	async hydrated(context: Context): Promise<void> {
		if (this.#state.kind === "bound" && this.#state.target.hydrated) return;
		await this.#until((state) => {
			if (state.kind === "live") return DONE;
			if (state.kind === "failed") return { kind: "failed", error: state.cause.error };
			return WAIT;
		}, context);
	}

	/**
	 * Ends `watch` when this reference is released; returns it. A watch opened while the reference was released (an
	 * async keyed watch racing `release`) is ended at once, its pin with it, and the caller gets `released`.
	 */
	follow<W extends Watch<JsonValue>>(watch: W): W {
		if (this.#state.kind === "released") {
			watch.end({ kind: "ended" });
			throw this.#state.state.error;
		}
		this.#watches.add(watch);
		void watch.closed.then(() => this.#watches.delete(watch));
		return watch;
	}

	/**
	 * `ref.member.at(key)`: only while its object's factory runs (the reference not yet bound); pinned once bound
	 * (`pinKeys`), released with the reference.
	 */
	at(member: string, key: string): KeyedMemberAt {
		if (this.#state.kind !== "unbound" || this.#state.dependent === undefined) {
			throw new Error(`${this.#name}: ${member}.at(key) is valid only in the factory`);
		}
		const at = new KeyedMemberAt(this, member, key);
		this.#ats.push(at);
		return at;
	}

	/** Whether its object's factory pinned keys on it (`at(key)`). */
	get pinsKeys(): boolean {
		return this.#ats.length > 0;
	}

	/**
	 * Pins the keys of `at(key)` on the live object's keyed members and loads those not in memory, before the
	 * dependent goes live (slice 6a §12); `undefined` when there are none. A failed load rejects.
	 */
	pinKeys(context: Context): Promise<void> | undefined {
		if (this.#ats.length === 0) return undefined;
		return (async () => {
			for (const at of this.#ats) await at.pin(this, context);
		})();
	}

	/**
	 * `ref.retry()`, as a step of `walk` (a new one for `ref.retry()`, passed on through parked objects): the object is
	 * asked for an attempt now (ignored unless failed; a parked one passes it on); a refused reference is placed again;
	 * one waiting in the index is left as it is (an event wakes it).
	 */
	retry(walk: RetryWalk = retryWalk()): void {
		const state = this.#state;
		if (state.kind === "bound") {
			state.target.retry(walk);
			return;
		}
		if (state.kind !== "refused") return;
		this.#state = { kind: "unbound", batch: state.batch, dependent: state.dependent };
		this.moved();
		state.bind();
	}

	/** Releases the reference (idempotent); the object may end when it was its last. */
	release(): void {
		const state = this.#state;
		if (state.kind === "released") return;
		state.batch.assertOutside("release");
		// First: an object over a link rejects the calls itself and sends no cancel for them.
		if (state.kind === "bound") state.target.unhold(this);
		this.end(this.#released());
	}

	/**
	 * Ends the reference without releasing it from its object (it ended): watches end, calls (running and parked)
	 * reject with `error`, `ref.state` is `ended` with it; the object whose attempt declared it checks again.
	 */
	end(error: ChordError): void {
		// Kept by `ref.state`: its stack is made text now, so the error holds none of the frames' objects.
		void error.stack;
		const ended: Ended = { kind: "ended", error };
		const previous = this.#state;
		this.#state = { kind: "released", state: ended };
		this.#contract = undefined;
		if (previous.kind === "waiting") previous.leave();
		for (const at of this.#ats) at.release();
		// Its members' and keys' watches end, derives over them are marked; their instance subscriptions go.
		const sources = this.#sources;
		const keys = this.#heldKeys;
		this.#sources = undefined;
		this.#heldKeys = undefined;
		this.#attached = undefined;
		if (previous.kind !== "released" && (sources !== undefined || keys !== undefined)) {
			const end = (): void => {
				for (const source of sources?.values() ?? []) source.end(error);
				keys?.end(error);
			};
			// A batch only when something still follows them (an ending object's derives detached already).
			const used = keys !== undefined || [...(sources?.values() ?? [])].some((source) => source.inUse);
			if (used) previous.batch.within(end, BACKGROUND_CONTEXT);
			else end();
		}
		this.#calls?.abort(error);
		this.#calls = undefined;
		this.#parked?.reject(error);
		this.#parked = undefined;
		for (const watch of this.#watches) watch.end({ kind: "ended" });
		this.#refState?.released(ended);
		// Each removes itself; promise reactions run later.
		for (const waiter of this.#waiters) waiter.end(error);
		// An ended dependency breaks a parked dependent (it cannot come back).
		if (previous.kind !== "released") previous.dependent?.dependencyMoved();
	}

	#call(method: string, args: unknown, context: Context): Promise<unknown> {
		const state = this.refState;
		switch (state.kind) {
			case "live":
				// Calls queued before it went live are still being sent: a new one never overtakes them.
				if (this.#parked?.waiting) return this.#parked.park(method, args, context);
				return this.#send(method, args, context);
			case "loading":
				this.#parked ??= new ParkedCalls(this.#parkTimeout, this.label);
				return this.#parked.park(method, args, context);
			case "failed":
				throw state.cause.error;
			case "ended":
				throw state.error;
		}
	}

	/** Calls the live object; the call is aborted when the reference ends. */
	#send(method: string, args: unknown, context: Context): Promise<unknown> {
		// Only a bound reference is live.
		const { target } = this.#state as Extract<BindingState, { readonly kind: "bound" }>;
		this.#calls ??= new AbortController();
		const linked = withLinkedAbortSignal(this.#calls.signal, context);
		return target.call(method, args, linked.context, this.caller, this.contract.version).finally(linked.release);
	}

	/**
	 * Settles once `decide` does for the reference's state, checked now and at every change; rejects when the reference
	 * ends (with its error, `released` when it is released already) or `context` aborts.
	 */
	#until(decide: (state: RefState) => Decision, context: Context): Promise<void> {
		if (this.#state.kind === "released") return Promise.reject(this.#state.state.error);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const signal = context.abortSignal;
		const settle = (done: () => void): void => {
			this.#waiters.delete(waiter);
			signal?.removeEventListener("abort", abort);
			done();
		};
		const waiter: Waiter = {
			check: () => {
				const decision = decide(this.refState);
				if (decision.kind === "done") settle(resolve);
				else if (decision.kind === "failed") settle(() => reject(decision.error));
			},
			end: (error) => settle(() => reject(error)),
		};
		const abort = (): void => settle(() => reject(signal?.reason));
		this.#waiters.add(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		else waiter.check();
		return promise;
	}

	#watchableState(): ReferenceState {
		if (this.#refState !== undefined) return this.#refState;
		const state = this.#state;
		// A released reference's state never changes: it is made ended, keeping no batch.
		if (state.kind === "released") {
			const made = new ReferenceState(() => this.refState, undefined);
			made.released(state.state);
			this.#refState = made;
			return made;
		}
		this.#refState = new ReferenceState(() => this.refState, state.batch);
		return this.#refState;
	}

	#variant(): string | undefined {
		const state = this.#state;
		if (state.kind === "released") throw state.state.error;
		return state.kind === "bound" ? state.target.variant : undefined;
	}

	/** The error of this reference's release by its holder (`released`, no reason). */
	#released(): ChordError {
		return new ChordError({ code: "released", message: `${this.#name}: released` });
	}
}

/** A state member of a reference: the provider's member, followed through this reference. */
class ReferenceMember {
	readonly #binding: Binding;
	readonly #member: string;

	constructor(binding: Binding, member: string) {
		this.#binding = binding;
		this.#member = member;
	}

	get value(): JsonValue {
		return this.source.value;
	}

	watch(context: Context): Promise<Watch<JsonValue>> {
		return this.#binding.watch(this.#member, context);
	}

	/** The provider's member: a source or a constant. */
	get source(): DeriveSource {
		return this.#binding.member(this.#member);
	}
}

/** A keyed member of a reference (slice 6a §12): reads by key behave as calls (they wait while loading). */
class ReferenceKeyed {
	readonly #binding: Binding;
	readonly #member: string;

	constructor(binding: Binding, member: string) {
		this.#binding = binding;
		this.#member = member;
	}

	/** The provider's slot: the ultimate provider's, through re-exposures (rule 22). */
	get slot(): KeyedSlot {
		return this.#binding.keyedSlot(this.#member);
	}

	/** This member as another object re-exposing it has it: its keys held through this reference. */
	get keyed(): KeyedBinding {
		return { kind: "reexposed", binding: this.#binding, member: this.#member };
	}

	async get(key: string, context: Context): Promise<JsonValue | undefined> {
		await this.#binding.hydrated(context);
		const slot = this.slot;
		const map = this.#binding.keyedMapping(this.#member);
		const value = await slot.get(key, ownAccess(slot), context);
		return map === undefined || value === undefined ? value : map(value);
	}

	/**
	 * A watch of the document at `key` across the object's attempts (it holds the key through the object), `undefined`
	 * when absent; it ends with this reference.
	 */
	async watch(key: string, context: Context): Promise<Watch<JsonValue> | undefined> {
		await this.#binding.firstValues(context);
		const slot = this.slot;
		if ((await slot.get(key, ownAccess(slot), context)) === undefined) return undefined;
		// Mapped to its version when older (slice 7b §7), across its object's instances (`ReferenceKeys`).
		const held = await this.#binding.pinKey(this.#member, key, context);
		// Retired between the read and now: absent.
		if (slot.current(slot.key(key)) === undefined) {
			held.release();
			return undefined;
		}
		let watch: Watch<JsonValue>;
		try {
			watch = held.source.openWatch(context);
		} catch (error) {
			held.release();
			throw error;
		}
		void watch.closed.then(held.release);
		return this.#binding.follow(watch);
	}

	at(key: string): Watchable<JsonValue> {
		// The pinned key's values are the member's documents.
		return this.#binding.at(this.#member, key) as unknown as Watchable<JsonValue>;
	}
}

/** A consumer reads its provider's keyed documents as the provider's own code may: current version, own token. */
function ownAccess(slot: KeyedSlot): { readonly token: SealToken; readonly version: number } {
	return { token: slot.owner.own, version: slot.definition.current.version };
}

/** Where a `ref.member.at(key)` stands: not held yet, held on the object's keyed member, or released for good. */
type AtState =
	| { readonly kind: "unpinned" }
	| { readonly kind: "pinned"; readonly source: DeriveSource; readonly release: () => void }
	| { readonly kind: "released" };

/**
 * `ref.member.at(key)`: the key's source across the object's attempts once the reference is bound and the key held
 * (`pin`), until the reference ends (`release`, exactly once): then it drops the source (a retained reference keeps no
 * provider).
 */
class KeyedMemberAt {
	readonly #binding: Binding;
	readonly member: string;
	readonly key: string;
	#state: AtState = { kind: "unpinned" };

	constructor(binding: Binding, member: string, key: string) {
		this.#binding = binding;
		this.member = member;
		this.key = key;
	}

	/** The key's source; `not_ready` before it is held, `released` after. */
	get source(): DeriveSource {
		const state = this.#state;
		if (state.kind === "pinned") return state.source;
		const what = `${this.member}.at(${this.key})`;
		if (state.kind === "released") throw new ChordError({ code: "released", message: `${what}: released` });
		throw new ChordError({ code: "not_ready", message: `${what}: not loaded yet` });
	}

	get value(): JsonValue {
		return this.source.value;
	}

	async watch(context: Context): Promise<Watch<JsonValue>> {
		return this.#binding.follow(this.source.openWatch(context));
	}

	/**
	 * Holds the key through `binding` (once), loaded, mapped to an older binding's version (slice 7b §7); nothing once
	 * released (a hold that lands then is released).
	 */
	async pin(binding: Binding, context: Context): Promise<void> {
		if (this.#state.kind !== "unpinned") return;
		const held = await binding.pinKey(this.member, this.key, context);
		if (this.#state.kind !== "unpinned") {
			held.release();
			return;
		}
		this.#state = { kind: "pinned", source: held.source, release: held.release };
	}

	/** Releases the pin and drops the source (once). */
	release(): void {
		const state = this.#state;
		this.#state = { kind: "released" };
		if (state.kind === "pinned") state.release();
	}
}

/**
 * What a keyed member's value is (slice 6a §12): a keyed document handle's slot, or a reference's keyed member
 * (re-exposed); `undefined` for anything else.
 */
export function resolveKeyed(value: unknown): KeyedBinding | undefined {
	if (value instanceof Keyed) return { kind: "own", slot: value.slot };
	if (value instanceof ReferenceKeyed) return value.keyed;
	return undefined;
}

/**
 * The watchable Chord follows behind a state member or a derive source (Q14): a source or a constant itself, a
 * singleton handle's slot, a reference member's provider member, a keyed member's pinned key (a key source itself for
 * `handle.at(key)`); `undefined` for anything else, a native watchable included.
 */
export function resolveWatchable(value: unknown): DeriveSource | undefined {
	if (value instanceof Singleton) return value.slot;
	if (value instanceof ReferenceMember) return value.source;
	if (value instanceof KeyedMemberAt) return value.source;
	if (value instanceof Source || value instanceof Constant) return value;
	return undefined;
}

/**
 * Points `source` at what its reference follows now (`Followed`), inside a batch; a new one takes its last value from
 * the instance that stopped, only when its reference was attached to that one (`attached`).
 */
function place(source: ReferenceSource, followed: Followed, attached: unknown): void {
	switch (followed.kind) {
		case "live":
			source.bind(followed.source);
			return;
		case "lacking":
			source.vanish(followed.error, BACKGROUND_CONTEXT);
			return;
		case "loading":
			if (source.unbound && followed.last !== undefined && followed.instance === attached)
				source.bind(followed.last);
			source.hold();
			return;
		case "failed":
			if (source.unbound && followed.last !== undefined && followed.instance === attached)
				source.bind(followed.last);
			source.fail(followed.error, BACKGROUND_CONTEXT);
			return;
	}
}
