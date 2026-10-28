// Watch handles: the watch types and the one implementation of their lifecycle, for JSON and native values.
import { type Context, withoutAbortSignal } from "./context/index.ts";
import { type Op, PendingOps } from "./delta/index.ts";
import type { JsonValue } from "./json.ts";

/**
 * Terminal result of one watch, tagged by `kind`. A watch ends only for good; a failure its source recovers from is a
 * `failed` call (`WatchCall`), and the watch stays open.
 *
 * - `stopped`: `stop()` was called.
 * - `aborted`: the context the watch was acquired with was aborted.
 * - `ended`: the source closed (its owner ended or closed).
 * - `listener_error`: the listener threw or rejected with `error`.
 * - `failed`: the source failed for good with `error`.
 */
export type WatchEnd =
	| { readonly kind: "stopped" | "aborted" | "ended" }
	| { readonly kind: "listener_error"; readonly error: Error }
	| { readonly kind: "failed"; readonly error: unknown };

/**
 * One call of a JSON watch's listener, and one frame a source hands its watch, tagged by `kind`:
 *
 * - `value`: the newest value, the ops that turn the previous value into it, and whether the document the watch follows
 *   was retired since the previous value call. A retirement does not end the watch: `value` is then what the address
 *   shows after it (the source decides; a Durable document keeps the last value the watch was given, with no ops), and a
 *   document created there later arrives as `[["r", value]]`, possibly in the same call.
 * - `failed`: the source cannot compute its value now, with `error`; the watch stays open, and the next value arrives as
 *   `[["r", value]]`. `WatchHandle.value` keeps the last value.
 *
 * Plain data: the frame's context is the listener's second argument, never part of the call.
 */
export type WatchCall<T> =
	| { readonly kind: "value"; readonly value: T; readonly ops: readonly Op[]; readonly retired: boolean }
	| { readonly kind: "failed"; readonly error: unknown };

/** One call of a native watch's listener: the new value, or a failure its source may recover from, as in `WatchCall`. */
export type NativeWatchCall<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown };

/**
 * Serialized observation of an immutable value: one listener call at a time; changes made meanwhile arrive folded into
 * the next call.
 */
export interface WatchHandle<T> {
	/** Acquisition revision before start; latest delivered immutable revision afterward (a `failed` call keeps it). */
	readonly value: T;
	/** Install the sole asynchronous listener. Never invokes it inline. */
	start(listener: (call: WatchCall<T>, context: Context) => Promise<void>): void;
	/** Idempotently stop future callbacks and return this watch's terminal result. */
	stop(): Promise<WatchEnd>;
	/** Settle when the watch terminates; an already-running callback remains caller-owned. */
	readonly closed: Promise<WatchEnd>;
}

/**
 * A value that changes and can be watched: documents, derives, members of references. Values are immutable by
 * convention (JSON for state); each watch starts at the current value and then gets the changes, folded while its
 * listener is busy.
 */
export interface Watchable<T> {
	/** The current value. */
	readonly value: T;
	/** A watch holding the current value, then its changes; aborting the context ends it. */
	watch(context: Context): Promise<WatchHandle<T>>;
}

/**
 * An in-process value that changes and can be watched (it may hold anything, errors and functions included): a change
 * is a new value by identity, delivered without ops.
 */
export interface NativeWatchable<T> {
	/** The current value. */
	readonly value: T;
	/** A watch holding the current value, then one frame per new value; aborting the context ends it. */
	watch(context: Context): Promise<NativeWatchHandle<T>>;
}

/**
 * Serialized observation of an in-process value: as `WatchHandle`, but each new value is its own call, in order, without
 * ops.
 */
export interface NativeWatchHandle<T> {
	/** Acquisition value before start; latest delivered value afterward (a `failed` call keeps it). */
	readonly value: T;
	/** Install the sole asynchronous listener. Never invokes it inline. */
	start(listener: (call: NativeWatchCall<T>, context: Context) => Promise<void>): void;
	/** Idempotently stop future callbacks and return this watch's terminal result. */
	stop(): Promise<WatchEnd>;
	/** Settle when the watch terminates; an already-running callback remains caller-owned. */
	readonly closed: Promise<WatchEnd>;
}

type Listener<C> = (call: C, context: Context) => Promise<void>;

const STOPPED: WatchEnd = { kind: "stopped" };
const ABORTED: WatchEnd = { kind: "aborted" };
const ENDED: WatchEnd = { kind: "ended" };

/** A failure call, as both call types have it. */
type FailedCall = { readonly kind: "failed"; readonly error: unknown };

/**
 * The lifecycle both handles share: serialized delivery and termination. A source feeds it and ends it explicitly;
 * termination drops every reference the watch holds into its source, so a stopped watch that is still referenced keeps
 * nothing but its last value alive. Subclasses keep what is pending, each call apart from its frame's context, so the
 * call a listener gets carries nothing but its data.
 */
abstract class WatchLifecycle<T, C extends { readonly kind: "value"; readonly value: T } | FailedCall> {
	#detach: (() => void) | undefined;
	#report: ((error: unknown) => void) | undefined;
	readonly #closed = Promise.withResolvers<WatchEnd>();
	#value: T;
	#listener: Listener<C> | undefined;
	#started = false;
	#scheduled = false;
	#running = false;
	/** Set by `endAfterDelivery()`: the source sends nothing more; the watch ends `ended` once it delivered the rest. */
	#ending = false;
	/** Set once, by `#terminate()`. */
	#end: WatchEnd | undefined;
	#abortSignal: AbortSignal | undefined;
	#abortListener: (() => void) | undefined;

	constructor(value: T, detach: () => void, report: (error: unknown) => void) {
		this.#value = value;
		this.#detach = detach;
		this.#report = report;
	}

	get value(): T {
		return this.#value;
	}

	get closed(): Promise<WatchEnd> {
		return this.#closed.promise;
	}

	start(listener: Listener<C>): void {
		if (this.#started) throw new Error("Watch is already started");
		if (this.#end !== undefined) throw new Error("Watch is stopped");
		this.#started = true;
		this.#listener = listener;
		this.#schedule();
	}

	stop(): Promise<WatchEnd> {
		this.#terminate(STOPPED);
		return this.#closed.promise;
	}

	/** End the watch `aborted` when `signal` aborts; installed once. */
	observeAbort(signal: AbortSignal): void {
		if (this.#abortSignal !== undefined) throw new Error("Watch abort is already installed");
		if (this.#end !== undefined) return;
		this.#abortSignal = signal;
		this.#abortListener = () => this.abort();
		signal.addEventListener("abort", this.#abortListener, { once: true });
		if (signal.aborted) this.abort();
	}

	/** End the watch `aborted`: its acquisition context was aborted. */
	abort(): void {
		this.#terminate(ABORTED);
	}

	/**
	 * End the watch with `end` at once, dropping what is pending: the source closed (`ended`), or failed for good
	 * (`failed`). A failure the source may recover from is a `failed` call instead (`fail()`).
	 */
	end(end: WatchEnd): void {
		this.#terminate(end);
	}

	/**
	 * The source sends nothing more after its last frames, such as a retirement: take no more frames, deliver what is
	 * pending, then end `ended`, after the running call returns, if one runs. Until then the watch stays attached, so
	 * `end()`, `stop()`, an abort, and a throwing listener still end it first; a watch never started keeps what is
	 * pending until one of them or `start()`.
	 */
	endAfterDelivery(): void {
		if (this.#end !== undefined || this.#ending) return;
		this.#ending = true;
		if (!this.#running && this.pendingContext === undefined) this.#terminate(ENDED);
	}

	/** Whether the watch still takes frames: it has not ended, and its source has not ended. */
	protected get open(): boolean {
		return this.#end === undefined && !this.#ending;
	}

	/** The context of the newest frame the next call covers, or undefined when nothing is pending. */
	protected abstract get pendingContext(): Context | undefined;

	/** Take the next call; called only while something is pending. */
	protected abstract next(): C;

	/** Drop everything pending and every reference into the source; called once, on termination. */
	protected abstract release(): void;

	/** Something became pending: deliver it once started, never inline. */
	protected pending(): void {
		if (this.#started) this.#schedule();
	}

	#schedule(): void {
		if (this.#scheduled || this.#running || this.#end !== undefined) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			void this.#drain();
		});
	}

	/**
	 * Deliver until nothing is pending; what arrives during a call is taken after it returns. A watch whose source ended
	 * ends once it delivered the rest and its last call returned.
	 */
	async #drain(): Promise<void> {
		if (this.#running || this.#end !== undefined || !this.#started) return;
		this.#running = true;
		try {
			while (this.#end === undefined) {
				const listener = this.#listener;
				if (listener === undefined) break;
				const frameContext = this.pendingContext;
				if (frameContext === undefined) {
					if (this.#ending) this.#terminate(ENDED);
					break;
				}
				const call = this.next();
				if (call.kind === "value") this.#value = call.value;
				try {
					await listener(call, withoutAbortSignal(frameContext));
				} catch (error) {
					if (this.#end === undefined) {
						this.#report?.(error);
						this.#terminate({ kind: "listener_error", error: toError(error) });
					}
					break;
				}
			}
		} finally {
			this.#running = false;
		}
	}

	/**
	 * End the watch, once: detach, drop what is pending and every reference into the source, and settle `closed`. A
	 * callback already running keeps running.
	 */
	#terminate(end: WatchEnd): void {
		if (this.#end !== undefined) return;
		this.#end = end;
		const detach = this.#detach;
		this.#detach = undefined;
		this.#report = undefined;
		this.#listener = undefined;
		this.release();
		if (this.#abortListener !== undefined) this.#abortSignal?.removeEventListener("abort", this.#abortListener);
		this.#abortSignal = undefined;
		this.#abortListener = undefined;
		detach?.();
		this.#closed.resolve(end);
	}
}

function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	try {
		return new Error(String(error));
	} catch {
		return new Error(Object.prototype.toString.call(error));
	}
}

/**
 * The watch handle of a JSON source. Frames that arrive before `start()` or while the listener runs wait in one
 * `PendingOps` queue; the next call gets the newest value, the folded ops of every frame since the previous call (or
 * `[["r", newest]]` after the queue overflowed), `retired` when any of them was a retirement, and the newest frame's
 * context. A frame delivered alone is passed on as the source made it. A failure (`fail()`) drops the pending frames and
 * waits as one `failed` call; a value after it replaces it, and the first value call after a failure is `[["r",
 * value]]`. `detach` unsubscribes it from its source on termination; `report` gets a listener's throw, which also ends
 * the watch.
 */
export class Watch<T> extends WatchLifecycle<T, WatchCall<T>> implements WatchHandle<T> {
	readonly #ops = new PendingOps();
	/**
	 * The source's call while it is the only frame pending: the call passes it on, with no allocation. A second frame
	 * drops it, so its ops stay only as long as `PendingOps` keeps them (folded, or dropped by an overflow).
	 */
	#lone: WatchValueCall<T> | undefined;
	/** The newest frame's value and context, while a call is pending; the context also marks that one is. */
	#newestValue: T | undefined;
	#newestContext: Context | undefined;
	/** A pending frame was a retirement. */
	#retired = false;
	/** The newest frame was a failure: the next call is this. */
	#failure: FailedCall | undefined;
	/** A failure came after the last value call: the next value call replaces the root, and ops are not kept. */
	#replace = false;

	/**
	 * Queue the frame `call`. A value's ops turn the previous value into it, and `retired` says the document the watch
	 * follows was retired, which the next value call reports however many frames it folds; a failure is `fail()`.
	 */
	advance(call: WatchCall<T>, context: Context): void {
		if (call.kind === "failed") {
			this.#fail(call, context);
			return;
		}
		if (!this.open) return;
		if (this.#replace) {
			this.#failure = undefined;
		} else {
			this.#lone = this.#newestContext === undefined ? call : undefined;
			this.#ops.push(call.ops);
		}
		this.#newestValue = call.value;
		this.#newestContext = context;
		if (call.retired) this.#retired = true;
		this.pending();
	}

	/**
	 * Queue a failure the source may recover from: the pending frames are dropped (`value` keeps the last delivered
	 * value), the listener gets `{ kind: "failed", error }`, and the next value arrives as `[["r", value]]`.
	 */
	fail(error: unknown, context: Context): void {
		this.#fail({ kind: "failed", error }, context);
	}

	#fail(call: FailedCall, context: Context): void {
		if (!this.open) return;
		this.#ops.take();
		this.#lone = undefined;
		this.#newestValue = undefined;
		this.#failure = call;
		this.#newestContext = context;
		this.#replace = true;
		this.pending();
	}

	protected get pendingContext(): Context | undefined {
		return this.#newestContext;
	}

	protected next(): WatchCall<T> {
		// After a failure the call is that failure, or the value after it; otherwise one field read decides.
		if (this.#replace) return this.#nextAfterFailure();
		const lone = this.#lone;
		// Set with the context, which says a frame is pending.
		const value = this.#newestValue as T;
		const batch = this.#ops.take();
		const retired = this.#retired;
		this.#lone = undefined;
		this.#newestValue = undefined;
		this.#newestContext = undefined;
		this.#retired = false;
		// One frame never folds or overflows: its call is the listener's.
		if (lone !== undefined) return lone;
		// Values of a JSON watch are JSON; `T` is the source's narrower or wider view of them (e.g. a typed document).
		const ops: readonly Op[] = batch.kind === "ops" ? batch.ops : [["r", value as JsonValue]];
		return { kind: "value", value, ops, retired };
	}

	/** The pending failure, or the value after one as a root replacement (no ops were kept since the failure). */
	#nextAfterFailure(): WatchCall<T> {
		const failure = this.#failure;
		this.#newestContext = undefined;
		if (failure !== undefined) {
			this.#failure = undefined;
			return failure;
		}
		const value = this.#newestValue as T;
		const retired = this.#retired;
		this.#newestValue = undefined;
		this.#retired = false;
		this.#replace = false;
		return { kind: "value", value, ops: [["r", value as JsonValue]], retired };
	}

	protected release(): void {
		this.#ops.take();
		this.#lone = undefined;
		this.#newestValue = undefined;
		this.#newestContext = undefined;
		this.#retired = false;
		this.#failure = undefined;
		this.#replace = false;
	}
}

/** The value call of a JSON watch. */
type WatchValueCall<T> = Extract<WatchCall<T>, { readonly kind: "value" }>;

/** Maximum values retained behind one unavailable native watch listener. */
const MAX_PENDING_NATIVE_VALUES = 100;

/**
 * The watch handle of a native source: every value in order, one call each; past 100 pending values they collapse to
 * one, `replace()` or by default the newest value. A failure (`fail()`) drops the pending values and waits as one
 * `failed` call; a value after it replaces it. `detach` and `report` as for `Watch`.
 */
export class NativeWatch<T> extends WatchLifecycle<T, NativeWatchCall<T>> implements NativeWatchHandle<T> {
	/**
	 * Pending values in order, each followed by its frame's context, from `#head` on. Values are kept raw: the call a
	 * listener gets is built when it is taken, so a value an overflow drops costs no object. A read index instead of
	 * `shift()` takes a backlog in constant time per value; taken slots are cleared at once, the array is emptied once
	 * all of it was taken, and its taken prefix dropped after 100 values.
	 */
	readonly #pending: Array<T | Context | undefined> = [];
	#head = 0;
	#replace: (() => T) | undefined;
	/** A pending failure and its frame's context; nothing else is pending meanwhile. */
	#failure: FailedCall | undefined;
	#failureContext: Context | undefined;

	constructor(value: T, detach: () => void, report: (error: unknown) => void, replace?: () => T) {
		super(value, detach, report);
		this.#replace = replace;
	}

	/** Queue `value`, the source's new value; it replaces a pending failure. */
	advance(value: T, context: Context): void {
		if (!this.open) return;
		this.#failure = undefined;
		this.#failureContext = undefined;
		if (this.#pending.length - this.#head < 2 * MAX_PENDING_NATIVE_VALUES) {
			this.#pending.push(value, context);
		} else {
			this.#pending.length = 0;
			this.#head = 0;
			this.#pending.push(this.#replace === undefined ? value : this.#replace(), context);
		}
		this.pending();
	}

	/**
	 * Queue a failure the source may recover from: the pending values are dropped (`value` keeps the last delivered
	 * value), and the listener gets `{ kind: "failed", error }`.
	 */
	fail(error: unknown, context: Context): void {
		if (!this.open) return;
		this.#pending.length = 0;
		this.#head = 0;
		this.#failure = { kind: "failed", error };
		this.#failureContext = context;
		this.pending();
	}

	protected get pendingContext(): Context | undefined {
		// The slot after a value holds its context; past the end it is empty.
		return this.#failureContext ?? (this.#pending[this.#head + 1] as Context | undefined);
	}

	protected next(): NativeWatchCall<T> {
		const failure = this.#failure;
		if (failure !== undefined) {
			this.#failure = undefined;
			this.#failureContext = undefined;
			return failure;
		}
		const head = this.#head;
		const pending = this.#pending;
		// The slot at `#head` holds a value.
		const value = pending[head] as T;
		if (head + 2 === pending.length) {
			pending.length = 0;
			this.#head = 0;
		} else if (head + 2 >= 2 * MAX_PENDING_NATIVE_VALUES) {
			// A backlog that never drains: drop the taken prefix, at most once per 100 values, so the array stays bounded.
			pending.copyWithin(0, head + 2);
			pending.length -= head + 2;
			this.#head = 0;
		} else {
			pending[head] = undefined;
			pending[head + 1] = undefined;
			this.#head = head + 2;
		}
		return { kind: "value", value };
	}

	protected release(): void {
		this.#pending.length = 0;
		this.#head = 0;
		this.#replace = undefined;
		this.#failure = undefined;
		this.#failureContext = undefined;
	}
}
