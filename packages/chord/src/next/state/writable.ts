// Writables (slice 8 §2, design §17): `self.writable(initial)`, an in-process value its attempt sets, identity
// compared; a contribution, a derive source and an `on` source, never a state member.

import type { Context } from "../../context/index.ts";
import type { NativeWatchable } from "../../watch.ts";
import type { Batch } from "./batch.ts";
import { FollowedSource } from "./native-source.ts";

/** An in-process value that changes when its owner sets it; `set` of the same value notifies nobody. */
export interface Writable<T> extends NativeWatchable<T> {
	/**
	 * Sets the value: a new value (by identity) is a new frame for its watches and marks the derives and registry
	 * tables reading it, in the batch running now or in one of its own. Throws `released` once its attempt ended, and
	 * `invalid/reentrant` inside a derive compute or a `compose`.
	 */
	set(value: T): void;
}

/** Who owns a writable: the context its own batches run in, and the check that its attempt still runs. */
export type WritableOwner = {
	readonly context: Context;
	/** Throws `released` once the attempt that made it was sealed. */
	assertUsable(): void;
};

/** Whom a writable belongs to: its running attempt, or nothing once that attempt ended (its error kept). */
type Ownership =
	| { readonly kind: "owned"; readonly owner: WritableOwner }
	| { readonly kind: "ended"; readonly error: Error };

/** A writable: its value, set by its owner's code, delivered through the host's batch. */
export class WritableSource<T> extends FollowedSource<T> implements Writable<T> {
	#value: T;
	#ownership: Ownership;

	constructor(initial: T, owner: WritableOwner, batch: Batch) {
		super(batch);
		this.#value = initial;
		this.#ownership = { kind: "owned", owner };
	}

	get value(): T {
		return this.#value;
	}

	set(value: T): void {
		const ownership = this.#ownership;
		if (ownership.kind === "ended") throw ownership.error;
		ownership.owner.assertUsable();
		// The cost guard: setting the value it has costs one comparison past the seal check.
		if (value === this.#value) return;
		const batch = this.batch!;
		batch.assertNotComputing("writable.set");
		this.#change(value, batch, ownership.owner.context);
	}

	/**
	 * Adopts `value` in the batch running now, or in one of its own. Apart from `set`: a closure there would make every
	 * `set` allocate its context, the same value's too.
	 */
	#change(value: T, batch: Batch, context: Context): void {
		batch.within(() => {
			this.#value = value;
			this.changed();
		}, context);
	}

	/**
	 * Its attempt ended with `error`: its watches end `ended`, `set` throws `error`, its value stays readable; it keeps
	 * neither its attempt nor the host.
	 */
	detach(error: Error): void {
		// Kept by `set`: its stack is made text now, so it holds none of the frames' objects.
		void error.stack;
		this.#ownership = { kind: "ended", error };
		this.end();
	}
}
