// The state of a reference (§7): loading, live, failed or ended; and `ref.state`, the native watchable that follows
// it.

import { BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import { NativeWatch } from "../../watch.ts";
import type { ChordError, FailureCause } from "../data/index.ts";
import { type Batch, NativeSource } from "../state/internal.ts";

/**
 * Where a reference stands. `loading`: its object activates, retries or is parked on dependencies still under way, it
 * waits for its host's publication or a parent link, or its link is down (the reference's coarser view of its object's
 * waiting and activating); `failed`: its object failed and no attempt runs (`transient`: `retryAt` is when its backoff
 * retries it; `broken`: no automatic retry), or nothing fits it or its object is parked on a failed dependency
 * (`waiting`: an event wakes it, `retryAt` undefined); `live`: bound; `ended`: for good, with the error that says why
 * (`released` without a reason: released by its holder; `released/ended`: its object ended; `released/closed`: its
 * host closed; `forbidden/revoked`).
 */
export type RefState =
	| { readonly kind: "loading" }
	| { readonly kind: "live" }
	| { readonly kind: "failed"; readonly cause: FailureCause; readonly retryAt: number | undefined }
	| { readonly kind: "ended"; readonly error: ChordError };

/** A failed reference's state. */
export type Failed = Extract<RefState, { readonly kind: "failed" }>;

/** An ended reference's state. */
export type Ended = Extract<RefState, { readonly kind: "ended" }>;

/** The states without fields, one object each: a change of state is a new object (a native watch compares by identity). */
export const LOADING: RefState = { kind: "loading" };

export const LIVE: RefState = { kind: "live" };

/**
 * `ref.state`, a native source: its value is the reference's state, read through `read`; each watch gets every new
 * state, in its own context (not one call per batch, as a followed source's), and ends `ended` when the reference is
 * released (the end is the notification). Derives reading it are marked in a batch of its own when it changes.
 */
export class ReferenceState extends NativeSource<RefState> {
	readonly #read: () => RefState;
	/** The watches with the contexts they were taken in, which their frames carry. */
	readonly #watches = new Map<NativeWatch<RefState>, Context>();
	/** The state the watches have: a change is announced only when the state is another object. */
	#last: RefState;

	constructor(read: () => RefState, batch: Batch | undefined) {
		super(batch);
		this.#read = read;
		this.#last = read();
	}

	get value(): RefState {
		return this.#read();
	}

	/** Every state in order: a watch sees each step it went through. */
	async watch(context: Context): Promise<NativeWatch<RefState>> {
		const state = this.#read();
		const batch = this.batch;
		// An ended reference has nothing more to announce, and keeps no host to report to.
		if (batch === undefined || state.kind === "ended") {
			const ended = new NativeWatch<RefState>(state, IGNORE, IGNORE);
			ended.end({ kind: "ended" });
			return ended;
		}
		batch.assertOutside("watch");
		const watch = new NativeWatch<RefState>(state, () => this.#watches.delete(watch), batch.reportListener);
		this.#watches.set(watch, context);
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		return watch;
	}

	/** The reference's state may have changed: every watch gets it when it is another state, derives are marked. */
	moved(): void {
		const state = this.#read();
		if (state === this.#last) return;
		this.#last = state;
		for (const [watch, context] of this.#watches) watch.advance(state, context);
		if (this.dependents.size > 0) this.#mark();
	}

	/** The reference ended (`ended`, the reference's state): every watch ends `ended`, derives are marked a last time. */
	released(ended: Ended): void {
		// An ended reference keeps nothing of its object: not the last failure's error, not the host.
		this.#last = ended;
		// Ending detaches, which deletes the current entry (safe while iterating) and runs no listener.
		for (const watch of this.#watches.keys()) watch.end({ kind: "ended" });
		const batch = this.batch;
		if (batch === undefined || this.dependents.size === 0) {
			this.end();
			return;
		}
		// Ended where the marks run: a release while a batch's flushes send marks in the next commit, after this.
		batch.within(() => {
			this.changed();
			this.end();
		}, BACKGROUND_CONTEXT);
	}

	/**
	 * Marks the derives reading it, in the batch running now or one of its own (apart from `moved`: a closure there
	 * would allocate on every state change). A reference has no context of its own: the background context.
	 */
	#mark(): void {
		this.batch?.within(() => this.changed(), BACKGROUND_CONTEXT);
	}
}

const IGNORE = (): void => {};
