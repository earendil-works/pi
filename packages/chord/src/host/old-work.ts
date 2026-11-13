// Old work during a reload (decision "Reload restarts every affected object; old work finishes on old code"): the calls
// running on a restart's open old attempt and every call they cause. A call is old work when its call chain (the method
// ctxs it runs under, found through its context) holds an attempt that a restart drains, or when it arrived as old work
// from another host (`call.old` on a trusted link). The host counts its open old attempts and the old calls it runs
// for other hosts, so outside reloads no chain is walked.

import { type Context, type ContextKey, createContextKey, withContextValue } from "../context/index.ts";
import type { ChordObject } from "./object.ts";

/** One link of a call chain: the attempt a method call runs on, and the chain of the call that made it (`up`). */
export type CallNode = {
	/** The attempt the call runs on: old work while that attempt drains for a restart. */
	readonly on: OldWorkSource;
	up(): CallNode | undefined;
};

/** What a call chain's node runs on: an attempt, or another host's old work. */
export type OldWorkSource = { readonly draining: boolean };

/** The key under which a context carries its call chain (a method ctx is its own node: no allocation per call). */
export const CALL_CHAIN: ContextKey<CallNode> = createContextKey<CallNode>("chord.callChain");

/**
 * The key under which an attempt's activation context carries its object: a call its opener makes is known as that
 * object's (its gate waits are the object's wait edges for reload cycles).
 */
export const OPENING: ContextKey<ChordObject> = createContextKey<ChordObject>("chord.opening");

/** The host's old work: whether a context runs under it, counted so that the check is free outside reloads. */
export class OldWork {
	/** The open old attempts of restarts and the old calls from other hosts running here now. */
	#count = 0;

	/** An old attempt began draining, or an old call from another host began running here. */
	open(): void {
		this.#count++;
	}

	/** The counterpart of `open`. */
	close(): void {
		this.#count--;
	}

	/** Whether `context` runs under old work (walked only while this host has any). */
	of(context: Context): boolean {
		if (this.#count === 0) return false;
		for (let node = context.value(CALL_CHAIN); node !== undefined; node = node.up()) {
			if (node.on.draining) return true;
		}
		return false;
	}
}

/** The chain node of a call that arrived as old work from another host: always old, with nothing above it. */
const REMOTE_OLD_WORK: CallNode = Object.freeze({ on: Object.freeze({ draining: true }), up: () => undefined });

/** `context` marked as old work that arrived from another host (`call.old` on a trusted link). */
export function asRemoteOldWork(context: Context): Context {
	return withContextValue(CALL_CHAIN, REMOTE_OLD_WORK, context);
}

/** The attempts of `context`'s call chain, for the reload cycle check (another host's old work has none here). */
export function chainAttempts(context: Context): ReadonlySet<OldWorkSource> {
	const attempts = new Set<OldWorkSource>();
	for (let node = context.value(CALL_CHAIN); node !== undefined; node = node.up()) {
		if (node !== REMOTE_OLD_WORK) attempts.add(node.on);
	}
	return attempts;
}
