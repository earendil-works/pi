// External stores over Chord's watchables (slice 11 §3): what React's `useSyncExternalStore` reads. A store's snapshot
// is the watchable's current value (`undefined` while it has none: a reference not bound yet, ended, or a member its
// variant lacks; nothing throws during a render); subscribing starts a watch whose every call notifies React, and the
// unsubscribe ends it.

import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";

/** What `useSyncExternalStore` takes: subscribe (returning its unsubscribe) and the current snapshot. */
export type ExternalStore<T> = {
	readonly subscribe: (changed: () => void) => () => void;
	readonly snapshot: () => T | undefined;
};

/** The store of `source` (a state member, a derive, a registry value, `ref.state`); none for `undefined`. */
export function watchStore<T>(source: Watchable<T> | NativeWatchable<T> | undefined): ExternalStore<T> {
	return {
		subscribe: (changed) => {
			if (source === undefined) return () => {};
			const abort = new AbortController();
			const context = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
			// A watch that cannot start (its source ended, the abort came first) only means no more changes.
			source.watch(context).then(
				(watch) => {
					(watch.start as (listener: () => Promise<void>) => void)(async () => {
						changed();
					});
					// A watch starts at the value it acquired, which may be newer than the snapshot React read (a
					// reference's members bind after the first render): its calls bring only later changes.
					changed();
				},
				() => {},
			);
			return () => abort.abort();
		},
		snapshot: () => {
			if (source === undefined) return undefined;
			try {
				return source.value;
			} catch {
				return undefined;
			}
		},
	};
}
