import { BACKGROUND_CONTEXT } from "../context/index.ts";
import { applyImmutable, isBase, type Op, type Tracker, track } from "../delta/index.ts";
import type { Context, JsonValue, MutableReplicatedState, ReplicatedState, ReplicatedStateDelivery } from "../types.ts";
import { registerReplicatedStateInternals } from "./state-internals.ts";

export class MutableReplicatedStateImpl<T extends object> implements MutableReplicatedState<T> {
	readonly #listeners = new Set<(value: T, context: Context, delivery: ReplicatedStateDelivery) => void>();
	readonly #sourceListeners = new Set<(ops: readonly Op[], sequence: number, context: Context) => void>();
	readonly #tracker: Tracker<T>;
	#publishedValue: T;
	#sequence = 0;

	constructor(initial: T) {
		this.#tracker = track(initial);
		this.#publishedValue = applyImmutable(undefined, this.#tracker.flush()) as unknown as T;
		const thisSource = this;
		registerReplicatedStateInternals(this, {
			get sequence() {
				return thisSource.#sequence;
			},
			get value() {
				return thisSource.#publishedValue;
			},
			publish: (context) => thisSource.publish(context),
			subscribe: (listener) => {
				thisSource.#sourceListeners.add(listener);
				return () => thisSource.#sourceListeners.delete(listener);
			},
		});
	}

	get value(): T {
		return this.#publishedValue;
	}

	get state(): T {
		return this.#tracker.state;
	}

	publish(context: Context): void {
		const ops = this.#tracker.flush();
		if (ops.length === 0) return;
		this.#sequence += 1;
		this.#publishedValue = applyImmutable(this.#publishedValue as unknown as JsonValue, ops) as unknown as T;
		for (const listener of [...this.#sourceListeners]) listener(ops, this.#sequence, context);
		const delivery = { kind: "update", sequence: this.#sequence } as const;
		for (const listener of [...this.#listeners]) listener(this.#publishedValue, context, delivery);
	}

	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void {
		const context = serviceDeliveryContext();
		this.publish(context);
		this.#listeners.add(listener);
		listener(this.#publishedValue, context, { kind: "hydrate", sequence: this.#sequence });
		return () => this.#listeners.delete(listener);
	}
}

/** A cold read-only state used by service consumers until a complete snapshot arrives. */
export class ReplicatedStateReplica<T extends JsonValue = JsonValue> implements ReplicatedState<T> {
	readonly #listeners = new Set<(value: T, context: Context, delivery: ReplicatedStateDelivery) => void>();
	readonly #reportError: (error: Error) => void;
	#value: T | undefined;
	#sequence: number | undefined;

	constructor(reportError: (error: Error) => void) {
		this.#reportError = reportError;
	}

	get value(): T | undefined {
		return this.#value;
	}

	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void {
		this.#listeners.add(listener);
		if (this.#value !== undefined) {
			this.#deliver(listener, this.#value, serviceDeliveryContext(), {
				kind: "hydrate",
				sequence: this.#sequence!,
			});
		}
		return () => this.#listeners.delete(listener);
	}

	hydrate(sequence: number, ops: readonly Op[], context: Context): void {
		if (!isBase(ops)) throw new Error("Replicated state snapshot is not a base operation batch");
		const value = applyImmutable<T>(undefined, ops);
		this.#sequence = sequence;
		this.#value = value;
		this.#deliverAll(context, { kind: "hydrate", sequence });
	}

	update(sequence: number, ops: readonly Op[], context: Context): void {
		if (this.#sequence === undefined || this.#value === undefined) {
			throw new Error("Replicated state received an update before hydration");
		}
		if (sequence !== this.#sequence + 1) {
			this.clear();
			throw new Error("Replicated state update sequence has a gap");
		}
		const value = applyImmutable(this.#value, ops);
		this.#sequence = sequence;
		this.#value = value;
		this.#deliverAll(context, { kind: "update", sequence });
	}

	clear(): void {
		this.#value = undefined;
		this.#sequence = undefined;
	}

	#deliverAll(context: Context, delivery: ReplicatedStateDelivery): void {
		if (this.#value === undefined) return;
		for (const listener of this.#listeners) this.#deliver(listener, this.#value, context, delivery);
	}

	#deliver(
		listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void,
		value: T,
		context: Context,
		delivery: ReplicatedStateDelivery,
	): void {
		try {
			listener(value, context, delivery);
		} catch (error) {
			this.#reportError(toError(error));
		}
	}
}

/** @internal Context for synthetic service deliveries without a caller. */
export function serviceDeliveryContext(): Context {
	// TODO: Add delivery-scoped cancellation or metadata if deliveries gain an owned lifecycle.
	return BACKGROUND_CONTEXT;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
