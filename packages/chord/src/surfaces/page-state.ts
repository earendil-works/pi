// Page state (decision "Tutorial gaps" (1), refining "Slice 11, P4"): values a client host keeps for its UI by key,
// beside its plugins, so a component of a reloaded plugin (a new function, which React or a terminal scope mounts
// anew) finds what it had: a half-typed message, a scroll position. Same-host values of any kind, never on the wire;
// gone with the host (a page reload, a terminal's new base bundle). `usePageState` and `TuiScope.pageState` read it.

import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";

/** One key's value in a host's page state. Its functions are bound: React's `useSyncExternalStore` takes them as is. */
export type PageState<T> = {
	/** The value now. */
	readonly read: () => T;
	/** Sets the value; a new value (by identity) calls every subscriber. */
	readonly set: (value: T) => void;
	/** Calls `changed` after every set that changed the value, until the returned unsubscribe. */
	readonly subscribe: (changed: () => void) => () => void;
};

/** Each client host's page state by key, kept as long as the host. */
const PAGE_STATES = new WeakMap<object, Map<string, PageState<unknown>>>();

/** The page state of `host` at `key`: what was kept there, or `initial` when the key is new. */
export function pageState<T, P extends Principal = Principal>(host: Host<P>, key: string, initial: T): PageState<T> {
	let states = PAGE_STATES.get(host);
	if (states === undefined) {
		states = new Map();
		PAGE_STATES.set(host, states);
	}
	let state = states.get(key);
	if (state === undefined) {
		state = keptValue<unknown>(initial);
		states.set(key, state);
	}
	// A key is the app's: whoever names it names its type too.
	return state as PageState<T>;
}

/** A value with its subscribers. */
function keptValue<T>(initial: T): PageState<T> {
	let value = initial;
	const subscribers = new Set<() => void>();
	return {
		read: () => value,
		set: (next) => {
			if (next === value) return;
			value = next;
			for (const changed of subscribers) changed();
		},
		subscribe: (changed) => {
			subscribers.add(changed);
			return () => {
				subscribers.delete(changed);
			};
		},
	};
}
