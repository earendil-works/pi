// Native sources (W4, slice 8 §2): in-process values that change, compared by identity (a `writable`, a registry's
// composed value, `ref.state`). Derives and registry tables depend on them and the batch marks them; the followed
// ones (writables, registry values) give their watches and observers one call per batch that changed them.

import type { Context } from "../../context/index.ts";
import {
	NativeWatch,
	type NativeWatchable,
	type NativeWatchCall,
	type NativeWatchHandle,
	type WatchEnd,
} from "../../watch.ts";
import type { Batch } from "./batch.ts";
import { type Dependent, handedOut } from "./watchable.ts";

/**
 * A synchronous observer of a native source (Durable's observer shape): `advance` is called inside the batch that
 * changed the source, so it only records; `end` once, when the source ended (`ended`) or the observer's context was
 * aborted (`aborted`).
 */
export interface NativeObserver<T> {
	/** The source's call of this batch: its new value, or a failure it may recover from. */
	advance(call: NativeWatchCall<T>, context: Context): void;
	/** The observer is detached for good with `end`. */
	end(end: WatchEnd): void;
}

/** What `observe` gives: the value the observer starts at, and how to detach it (Durable's `Observation`). */
export type NativeObservation<T> = { readonly value: T; detach(): void };

/**
 * What a new watch of a native source starts at: its value, or while it is failed, the failure and its last good value
 * (`last` undefined when it never had one: a watch cannot start then).
 */
export type NativeStart<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: { readonly value: T } | undefined };

/**
 * A native source as derives and registry tables read it: its value (`start()` while it may fail), the dependents a
 * change marks (`changed()`, inside a batch), and the host's batch until it ended. How its watches get their calls is
 * the subclass's (`FollowedSource` for writables and registry values; `ref.state` gives each state to its watches).
 */
export abstract class NativeSource<T = unknown> implements NativeWatchable<T> {
	/** Derives and registry tables reading this source; each removes itself when it stops. */
	readonly dependents = new Set<Dependent>();
	/** The host's batch; dropped when the source ended, so an ended source keeps no host. */
	#batch: Batch | undefined;

	/** `batch` undefined: made ended (a released reference's state). */
	constructor(batch: Batch | undefined) {
		this.#batch = batch;
	}

	abstract get value(): T;

	abstract watch(context: Context): Promise<NativeWatchHandle<T>>;

	/** What a new watch starts at; a source that can fail and recover tells its failure. */
	start(): NativeStart<T> {
		return { kind: "value", value: this.value };
	}

	/**
	 * Its value now as a contribution reads it: throws its failure while it is failed, where `.value` keeps the last good
	 * value for readers (a registry whose `compose` threw).
	 */
	current(): T {
		return this.value;
	}

	/** The host's batch, `undefined` once the source ended. */
	protected get batch(): Batch | undefined {
		return this.#batch;
	}

	/** Records a change inside the current batch: every dependent marked. */
	protected changed(): void {
		for (const dependent of this.dependents) dependent.invalidate();
	}

	/** Ends the source for good: its dependents dropped, the batch let go. */
	protected end(): void {
		this.#batch = undefined;
		this.dependents.clear();
	}
}

/**
 * What the watches and observers were last given: a value, a failure (one call per failure episode), or nothing yet
 * (a source with no value, followed for its first one).
 */
type Shown<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "failed" } | { readonly kind: "none" };

const ENDED: WatchEnd = { kind: "ended" };

const ABORTED: WatchEnd = { kind: "aborted" };

const FAILED: Shown<never> = { kind: "failed" };

const NONE = { kind: "none" } as const;

const NOTHING = (): void => {};

/**
 * A native source its followers get through the batch (a writable, a registry value): a change lists it for one frame
 * when someone follows it; the frame is its value then, delivered only when it is another value (identity) than the
 * one its followers have, or after a failure, whose call comes once per episode.
 */
export abstract class FollowedSource<T = unknown> extends NativeSource<T> {
	readonly #watches = new Set<NativeWatch<T>>();
	/** Synchronous observers and Chord's own subscribers (`retryOn`), fed inside the batch, each with its cleanup. */
	readonly #observers = new Map<NativeObserver<T>, () => void>();
	/** What the followers have; `undefined` while nobody follows (so no old value is kept). */
	#shown: Shown<T> | undefined;
	/** Listed for a frame in the current batch. */
	#listed = false;

	/** Whether a watch or an observer follows it (a registry value also while readers wait for its first value). */
	get watched(): boolean {
		return this.#watches.size > 0 || this.#observers.size > 0;
	}

	async watch(context: Context): Promise<NativeWatch<T>> {
		return this.openWatch(context);
	}

	/**
	 * `watch` without the Promise. On a failed source it opens at the last good value and its first call is the
	 * failure; with no value to start at it throws the failure. An ended source gives a watch that has ended.
	 */
	openWatch(context: Context): NativeWatch<T> {
		const batch = this.batch;
		if (batch === undefined) {
			const ended = new NativeWatch<T>(this.value, NOTHING, NOTHING);
			ended.end(ENDED);
			return ended;
		}
		batch.assertOutside("watch");
		const start = this.start();
		if (start.kind === "failed" && start.last === undefined) throw start.error;
		const value = start.kind === "value" ? start.value : start.last!.value;
		this.#follow(start);
		const watch: NativeWatch<T> = new NativeWatch(value, () => this.#unfollow(watch), batch.reportListener);
		this.#watches.add(watch);
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		if (start.kind === "failed") watch.fail(handedOut(start.error), context);
		return watch;
	}

	/**
	 * Attaches a synchronous observer at the current value (Durable's `observeXXX`); it counts as following, so a lazy
	 * value is computed in the batch that changed it. Throws the failure when there is no value to start at; aborting
	 * `context` detaches it (`aborted`); the source's end detaches it too (`ended`), its abort listener removed.
	 */
	observe(observer: NativeObserver<T>, context: Context): NativeObservation<T> {
		this.batch?.assertOutside("observe");
		const start = this.start();
		if (start.kind === "failed" && start.last === undefined) throw start.error;
		const value = start.kind === "value" ? start.value : start.last!.value;
		if (this.batch === undefined) {
			observer.end(ENDED);
			return { value, detach: NOTHING };
		}
		const signal = context.abortSignal;
		if (signal?.aborted) {
			observer.end(ABORTED);
			return { value, detach: NOTHING };
		}
		const aborted = (): void => {
			if (!this.#observers.has(observer)) return;
			this.unsubscribe(observer);
			observer.end(ABORTED);
		};
		const cleanup = signal === undefined ? NOTHING : () => signal.removeEventListener("abort", aborted);
		signal?.addEventListener("abort", aborted, { once: true });
		this.#follow(start);
		this.#observers.set(observer, cleanup);
		return { value, detach: () => this.unsubscribe(observer) };
	}

	/**
	 * Feeds `observer` every call from now on, inside each batch, also while the source has no value (Chord's own
	 * followers: `retryOn`). Nothing is delivered for the current value.
	 */
	subscribe(observer: NativeObserver<T>): void {
		if (this.batch === undefined) return;
		this.#follow(this.#startOrNone());
		this.#observers.set(observer, NOTHING);
	}

	unsubscribe(observer: NativeObserver<T>): void {
		const cleanup = this.#observers.get(observer);
		if (cleanup === undefined) return;
		this.#observers.delete(observer);
		cleanup();
		this.#settleFollowers();
	}

	/** Delivers this batch's frame: the new value when the followers have another, or a failure once per episode. */
	deliver(context: Context): void {
		this.#listed = false;
		const shown = this.#shown;
		if (shown === undefined) return;
		this.#deliver(shown, context);
		// Readers waiting for a first value pulled it through this delivery: nothing is kept for them.
		this.#settleFollowers();
	}

	/**
	 * Records a change inside the current batch: every dependent marked, and the source listed for a frame when someone
	 * follows it (or `watched` says so).
	 */
	protected override changed(): void {
		super.changed();
		this.list();
	}

	/**
	 * Lists the source for a frame in the current batch when someone follows it (or `watched` says so), its dependents
	 * left as they are (marked already).
	 */
	protected list(): void {
		if (this.#listed || !this.watched || this.batch === undefined) return;
		this.#listed = true;
		// Only readers waiting for a first value follow it without a follower's record: they have none. Not computed
		// here: marking runs inside adoptions, the value is pulled in the delivery.
		this.#shown ??= NONE;
		this.batch.changed(this);
	}

	/** Nothing follows it any more (no watch, no observer): a subclass drops what it kept for followers. */
	protected unfollowed(): void {}

	/** Ends the source for good: watches and observers end `ended` (their abort listeners removed). */
	protected override end(): void {
		super.end();
		this.#shown = undefined;
		// Ending detaches, which deletes the current entry (safe while iterating) and runs no listener.
		for (const watch of this.#watches) watch.end(ENDED);
		const observers = [...this.#observers];
		this.#observers.clear();
		for (const [observer, cleanup] of observers) {
			cleanup();
			observer.end(ENDED);
		}
	}

	#deliver(shown: Shown<T>, context: Context): void {
		const start = this.#startOrNone();
		if (start.kind === "failed") {
			// A failure reaches followers that had a value: those without one wait for the first.
			if (shown.kind !== "value") return;
			this.#shown = FAILED;
			const error = handedOut(start.error);
			for (const watch of this.#watches) watch.fail(error, context);
			for (const observer of [...this.#observers.keys()]) observer.advance({ kind: "failed", error }, context);
			return;
		}
		if (start.kind !== "value" || (shown.kind === "value" && shown.value === start.value)) return;
		const { value } = start;
		this.#shown = start;
		for (const watch of this.#watches) watch.advance(value, context);
		// A copy: an observer may detach itself in its call.
		for (const observer of [...this.#observers.keys()]) observer.advance({ kind: "value", value }, context);
	}

	/** Its start, `none` while it has no value. */
	#startOrNone(): NativeStart<T> | { readonly kind: "none" } {
		const start = this.start();
		return start.kind === "failed" && start.last === undefined ? NONE : start;
	}

	/** A follower comes: the first one records what followers have (a later one opened at the same current value). */
	#follow(start: NativeStart<T> | { readonly kind: "none" }): void {
		if (this.#shown !== undefined) return;
		this.#shown = start.kind === "failed" ? FAILED : start;
	}

	#unfollow(watch: NativeWatch<T>): void {
		this.#watches.delete(watch);
		this.#settleFollowers();
	}

	/** No follower left: nothing is shown any more, so no old value is kept. */
	#settleFollowers(): void {
		if (this.#watches.size > 0 || this.#observers.size > 0) return;
		this.#shown = undefined;
		this.unfollowed();
	}
}
