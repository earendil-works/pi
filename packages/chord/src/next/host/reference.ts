// References (§7): what `get` and `hold` return, a plain object built from the contract's members, and its binding to
// the object: counted as a reference, it follows the object's state, parks calls while loading, keeps the
// per-reference watches and is released once.

import type { Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { NativeWatchable, Watch, Watchable } from "../../watch.ts";
import type { Contract, Implementation, ParamsOf } from "../contracts/index.ts";
import {
	type CurrentVariants,
	currentVariants,
	type MethodData,
	type ShapeOf,
	takesNoArgs,
	type VariantImplementation,
} from "../contracts/internal.ts";
import { ChordError, type FailureCause } from "../data/index.ts";
import { Keyed, type KeyedSlot, type SealToken, Singleton } from "../documents/internal.ts";
import { type Batch, Constant, type DeriveSource, Source } from "../state/internal.ts";
import { type Caller, withLinkedAbortSignal } from "./ctx.ts";
import type { PinnedKey } from "./keyed-members.ts";
import type { KeyedBinding } from "./members.ts";
import type { ChordObject, Holder } from "./object.ts";
import { ParkedCalls } from "./parked.ts";
import { type Ended, type Failed, LOADING, ReferenceState, type RefState } from "./ref-state.ts";

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
	/** Asks a failed object for an attempt now (the backoff skipped, a broken one renewed); otherwise nothing. */
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
	/** The error of its last failed attempt while none went live since. */
	readonly lastFailure: ChordError | undefined;
	/** Its instance id while it activates on this host (Q5); `undefined` otherwise and over a link. */
	readonly activationId: string | undefined;
	/** The current attempt's outcome, which a dependent's activation waits for (R18). */
	readonly settled: Promise<void>;
	/** Counts `binding` as a reference; the binding reads `state` itself. */
	hold(binding: Binding): void;
	/** `binding` was released. */
	unhold(binding: Binding): void;
	/** Calls a method of the live object for `caller`. */
	call(method: string, args: unknown, context: Context, caller: Caller): Promise<unknown>;
	/**
	 * The state member `member` as Chord follows it: a local object's member source (across its attempts), or the
	 * replica of the last binding over a link.
	 */
	member(member: string): DeriveSource;
	/**
	 * Whether its members keep their last values while it is failed, for same-host reads and watches (a local object
	 * once an attempt went live, slice 6a §1.4); a remote object's failure is its reads' error.
	 */
	readonly lastValues: boolean;
	/** The keyed member `member` of the live object: its ultimate slot (slice 6a §12; only local objects have any). */
	keyedMember(member: string): KeyedSlot;
	/**
	 * Pins `key` of the keyed member `member` (a reference's `at(key)`, a key watch): its source across the object's
	 * attempts once loaded (`keyed-members.ts`); only a live local object takes it.
	 */
	pinKey(member: string, key: string, context: Context): Promise<PinnedKey>;
	/** `ref.retry()`: an attempt now if failed; ignored otherwise. */
	retry(): void;
	/**
	 * The chain of activation waits from this object to `target`, both included (Q5); `undefined` when there is none.
	 * `visited` keeps a search over shared dependencies linear in the waits.
	 */
	pathTo(target: ChordObject, visited: Set<Target>): ChordObject[] | undefined;
}

/** A reference's params as L1 checked them, with their identity key. */
export type CheckedParams = { readonly params: ParamsOf<Contract>; readonly key: string };

/**
 * Where a binding stands. `unbound`: waiting for `load` (a `host.hold`) or for its object's activation to bind it (a
 * `self.get`); `refused`: a `host.hold` whose type turned out not to be gettable here once `load` resolved; a released
 * binding keeps nothing but its name and its end (`ref.state`'s `ended`). `dependent` is the object whose attempt declared the reference with `self.get`,
 * `undefined` for `host.get`, `host.hold` and `ctx.get`.
 */
type BindingState =
	| { readonly kind: "unbound"; readonly batch: Batch; readonly dependent: ChordObject | undefined }
	| {
			readonly kind: "bound";
			readonly batch: Batch;
			readonly dependent: ChordObject | undefined;
			readonly target: Target;
	  }
	| { readonly kind: "refused"; readonly batch: Batch; readonly failure: Failed }
	| { readonly kind: "released"; readonly state: Ended };

/** What a wait for a state decides at each change. */
type Decision =
	| { readonly kind: "wait" }
	| { readonly kind: "done" }
	| { readonly kind: "failed"; readonly error: unknown };

const WAIT: Decision = { kind: "wait" };

const DONE: Decision = { kind: "done" };

const IGNORE = (): void => {};

/** A wait for a state: checked at every change, rejected with the reference's end. */
type Waiter = { readonly check: () => void; readonly end: (error: ChordError) => void };

/**
 * A reference's binding to its object: counted by the object as one of its references while bound, and told of each
 * change of its state. Calls run while live, park while loading (sent in order once live) and reject while failed.
 * Released, or ended with its object, it ends the watches taken through it and rejects the calls made through it.
 */
export class Binding implements Holder {
	readonly reference: Reference<Contract>;
	/** Who calls through this reference: the principal it was got as, and this host's incarnation. */
	readonly caller: Caller;
	/** The contract's name, for errors. */
	readonly #name: string;
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
	/** Resolved when the reference ends; made by the first `ended()`. */
	#ended: PromiseWithResolvers<void> | undefined;
	/** The keys its object's factory pinned with `ref.member.at(key)`: pinned once bound, released with it. */
	readonly #keys: KeyedMemberAt[] = [];

	constructor(
		contract: Contract,
		batch: Batch,
		dependent: ChordObject | undefined,
		caller: Caller,
		parkTimeout: number,
	) {
		this.#name = contract.name;
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

	/** The object whose attempt declared this reference, until it is released. */
	get dependent(): ChordObject | undefined {
		const state = this.#state;
		return state.kind === "unbound" || state.kind === "bound" ? state.dependent : undefined;
	}

	/** The reference's state. */
	get refState(): RefState {
		const state = this.#state;
		if (state.kind === "bound") return state.target.state;
		if (state.kind === "refused") return state.failure;
		return state.kind === "unbound" ? LOADING : state.state;
	}

	/** The object in errors: its label once bound, else the contract's name. */
	get label(): string {
		return this.#state.kind === "bound" ? this.#state.target.label : this.#name;
	}

	/** The error of the object's last failed attempt while none went live since. */
	get lastFailure(): ChordError | undefined {
		const state = this.#state;
		if (state.kind === "refused") return state.failure.cause.error;
		return state.kind === "bound" ? state.target.lastFailure : undefined;
	}

	/** Binds to `target`, which counts this binding as a reference; the reference takes its state. */
	bind(target: Target): void {
		const state = this.#state;
		if (state.kind !== "unbound") return;
		this.#state = { ...state, kind: "bound", target };
		target.hold(this);
		this.moved();
	}

	/** A `host.hold` that cannot be bound once `load` resolved: failed with `cause`, which no retry changes. */
	refuse(cause: FailureCause): void {
		const state = this.#state;
		if (state.kind !== "unbound") return;
		this.#state = { kind: "refused", batch: state.batch, failure: { kind: "failed", cause, retryAt: undefined } };
		this.moved();
	}

	/**
	 * The state may have changed: `ref.state`'s watches are told; live sends the parked calls in order, failed
	 * rejects them with the cause; waits for a state decide.
	 */
	moved(): void {
		this.#refState?.changed();
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
	 * The state member behind `member`: its last value while loading, and while failed when its object keeps one (a
	 * local object that went live once, slice 6a §1.4); throws `released`, `not_ready` before the first binding, and
	 * the failure's error otherwise.
	 */
	member(member: string): DeriveSource {
		const state = this.#state;
		if (state.kind === "bound" && state.target.lastValues) return state.target.member(member);
		return this.#target().member(member);
	}

	/** The keyed member `member`'s slot (slice 6a §12), as `member` resolves a state member. */
	keyedSlot(member: string): KeyedSlot {
		return this.#target().keyedMember(member);
	}

	/** Pins `key` of the keyed member `member` on the bound object (`Target.pinKey`), as `keyedSlot` resolves. */
	pinKey(member: string, key: string, context: Context): Promise<PinnedKey> {
		try {
			return this.#target().pinKey(member, key, context);
		} catch (error) {
			return Promise.reject(error);
		}
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
			case "refused":
				throw state.failure.cause.error;
			case "released":
				throw state.state.error;
		}
	}

	/**
	 * A watch of `member` that ends when this reference is released. Before the first binding it waits for it (and
	 * rejects when the reference fails or is released first); an object that keeps its last values (`lastValues`)
	 * gives a watch at once, which gets frames again when the object is live again.
	 */
	async watch(member: string, context: Context): Promise<Watch<JsonValue>> {
		// Checked here too: a constant's own watch has no batch to check. A released reference throws below.
		if (this.#state.kind !== "released") this.#state.batch.assertOutside("watch");
		if (this.#state.kind !== "bound" || !this.#state.target.lastValues) await this.hydrated(context);
		return this.follow(this.member(member).openWatch(context));
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
		this.#keys.push(at);
		return at;
	}

	/**
	 * Pins the keys of `at(key)` on the live object's keyed members and loads those not in memory, before the
	 * dependent goes live (slice 6a §12); `undefined` when there are none. A failed load rejects.
	 */
	pinKeys(context: Context): Promise<void> | undefined {
		if (this.#keys.length === 0) return undefined;
		return (async () => {
			for (const at of this.#keys) await at.pin(this, context);
		})();
	}

	/**
	 * Resolves when the reference ends (released, or its object ended); never rejects. A wait that must not keep the
	 * reference races it (a `host.hold` waiting for `load`).
	 */
	ended(): Promise<void> {
		if (this.#state.kind === "released") return Promise.resolve();
		this.#ended ??= Promise.withResolvers<void>();
		return this.#ended.promise;
	}

	/** `ref.retry()`: the object is asked for an attempt now; it ignores this unless failed. */
	retry(): void {
		if (this.#state.kind === "bound") this.#state.target.retry();
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
	 * reject with `error`, `ref.state` is `ended` with it.
	 */
	end(error: ChordError): void {
		// Kept by `ref.state`: its stack is made text now, so the error holds none of the frames' objects.
		void error.stack;
		const ended: Ended = { kind: "ended", error };
		this.#state = { kind: "released", state: ended };
		for (const at of this.#keys) at.release();
		this.#calls?.abort(error);
		this.#calls = undefined;
		this.#parked?.reject(error);
		this.#parked = undefined;
		for (const watch of this.#watches) watch.end({ kind: "ended" });
		this.#refState?.end(ended);
		// Each removes itself; promise reactions run later.
		for (const waiter of this.#waiters) waiter.end(error);
		this.#ended?.resolve();
		this.#ended = undefined;
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
		return target.call(method, args, linked.context, this.caller).finally(linked.release);
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
		// A released reference's state never changes: its watches end at once, with no listener to report. Bound, not a
		// closure: `read` would share the closure's scope and keep the batch after release.
		const [report, assertOutside] =
			state.kind === "released"
				? [IGNORE, IGNORE]
				: [state.batch.reportListener, state.batch.assertOutside.bind(state.batch, "watch")];
		this.#refState = new ReferenceState(() => this.refState, report, assertOutside);
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
		return slot.get(key, ownAccess(slot), context);
	}

	/**
	 * A watch of the document at `key` across the object's attempts (it holds the key through the object), `undefined`
	 * when absent; it ends with this reference.
	 */
	async watch(key: string, context: Context): Promise<Watch<JsonValue> | undefined> {
		await this.#binding.hydrated(context);
		const slot = this.slot;
		if ((await slot.get(key, ownAccess(slot), context)) === undefined) return undefined;
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

	/** Holds the key through `binding` (once), loaded; nothing once released (a hold that lands then is released). */
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
