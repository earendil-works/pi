// A remote reference as a UI reads it (slice 15 §1.5): the reference while it is live, and while it loads again after
// it was live (a rebind for another `granted`, a link drop: its tools stay up and its calls park), nothing otherwise
// (no reference, its first load, failed or denied, ended). What React's `useLive` and the TUI scope's `live` return,
// each with its own subscription to the reference's state and its memory of whether it was live. A rebind changes the
// reference's `granted` (a new set): what a UI compares to redraw when grantable members come or go.

import type { RefState } from "../host/index.ts";
import type { NativeWatchable } from "../watch.ts";

/** A remote reference, held or got: its state and the names it was granted. */
export type LiveRef = { readonly state: NativeWatchable<RefState>; readonly granted: ReadonlySet<string> };

/**
 * `ref.granted` while `ref` is live, or loading after it was live (`wasLive`); else `undefined`. True of the moment it
 * is read: no guarantee across an `await`.
 */
export function liveGrant(ref: LiveRef | undefined, wasLive: boolean): ReadonlySet<string> | undefined {
	if (ref === undefined) return undefined;
	const { kind } = ref.state.value;
	// `granted` throws on a released reference: read only while live or loading.
	if (kind === "live" || (kind === "loading" && wasLive)) return ref.granted;
	return undefined;
}
