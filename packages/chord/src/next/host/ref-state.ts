// The state of a reference (§7): loading, live, failed or ended; and `ref.state`, the native watchable that follows
// it.

import type { Context } from "../../context/index.ts";
import { NativeWatch, type NativeWatchable } from "../../watch.ts";
import type { ChordError, FailureCause } from "../data/index.ts";

/**
 * Where a reference stands. `loading`: its object activates or retries, it waits for `load` or a parent link, or its
 * link is down (the reference's coarser view of its object's waiting and activating); `failed`: its object failed and
 * no attempt runs (`retryAt` undefined: broken, no automatic retry); `live`: bound; `ended`: for good, with the error
 * that says why (`released` without a reason: released by its holder; `released/ended`: its object ended;
 * `released/closed`: its host closed; `forbidden/revoked`).
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

const IGNORE = (): void => {};

/**
 * `ref.state`: its value is the reference's state, read through `read`; each watch gets every new state, in its own
 * context, and ends `ended` when the reference is released (the end is the notification).
 */
export class ReferenceState implements NativeWatchable<RefState> {
	readonly #read: () => RefState;
	/** Where a listener's throw goes (the host); dropped on release, so a released reference keeps no host. */
	#report: (error: unknown) => void;
	/** Throws `invalid/reentrant` inside the host's batch (a watch taken in a derive compute); dropped on release. */
	#assertOutside: () => void;
	/** The watches with the contexts they were taken in, which their frames carry. */
	readonly #watches = new Map<NativeWatch<RefState>, Context>();
	/** The state the watches have: a change is announced only when the state is another object. */
	#last: RefState;

	constructor(read: () => RefState, report: (error: unknown) => void, assertOutside: () => void) {
		this.#read = read;
		this.#report = report;
		this.#assertOutside = assertOutside;
		this.#last = read();
	}

	get value(): RefState {
		return this.#read();
	}

	async watch(context: Context): Promise<NativeWatch<RefState>> {
		this.#assertOutside();
		const state = this.#read();
		const watch: NativeWatch<RefState> = new NativeWatch(state, () => this.#watches.delete(watch), this.#report);
		// An ended reference has nothing more to announce.
		if (state.kind === "ended") {
			watch.end({ kind: "ended" });
			return watch;
		}
		this.#watches.set(watch, context);
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		return watch;
	}

	/** The reference's state may have changed: every watch gets it when it is another state. */
	changed(): void {
		const state = this.#read();
		if (state === this.#last) return;
		this.#last = state;
		for (const [watch, context] of this.#watches) watch.advance(state, context);
	}

	/** The reference ended (`ended`, the reference's state): every watch ends `ended`. */
	end(ended: Ended): void {
		// An ended reference keeps nothing of its object: not the last failure's error, not the host.
		this.#last = ended;
		this.#report = IGNORE;
		this.#assertOutside = IGNORE;
		// Ending detaches, which deletes the current entry (safe while iterating) and runs no listener.
		for (const watch of this.#watches.keys()) watch.end({ kind: "ended" });
	}
}
