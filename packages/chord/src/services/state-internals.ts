import type { Op } from "../delta/index.ts";
import type { Context } from "../types.ts";

export interface ReplicatedStateInternals {
	readonly sequence: number;
	readonly value: unknown;
	publish(context: Context): void;
	subscribe(listener: (ops: readonly Op[], sequence: number, context: Context) => void): () => void;
}

const sources = new WeakMap<object, ReplicatedStateInternals>();

export function registerReplicatedStateInternals(value: object, internals: ReplicatedStateInternals): void {
	sources.set(value, internals);
}

export function getReplicatedStateInternals(value: unknown): ReplicatedStateInternals | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return sources.get(value);
}
