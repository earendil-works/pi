// A remote reference as a UI reads it (slice 15 §1.5): the reference while it is live, and while it loads again after
// it last settled live (a rebind, a link drop: its tools stay up and its calls park; the reference's own history, not
// what a UI read), nothing otherwise (no reference, its first load, failed or denied, ended): what `useLive` and
// `TuiScope.live` return. A rebind changes `granted` (a new set): what a UI compares to redraw.

import type { RefState } from "../host/index.ts";
import { WAS_LIVE } from "../host/internal.ts";
import type { NativeWatchable } from "../watch.ts";

/** A remote reference, held or got: its state, the names it was granted and whether it last settled live. */
export type LiveRef = {
	readonly state: NativeWatchable<RefState>;
	readonly granted: ReadonlySet<string>;
	readonly [WAS_LIVE]?: boolean;
};

/**
 * `ref.granted` while `ref` is live, or loading after it last settled live (by its own history, not by what a UI read
 * of it); else `undefined`. True of the moment it is read: no guarantee across an `await`.
 */
export function liveGrant(ref: LiveRef | undefined): ReadonlySet<string> | undefined {
	if (ref === undefined) return undefined;
	const { kind } = ref.state.value;
	// `granted` throws on a released reference: read only while live or loading.
	if (kind === "live" || (kind === "loading" && ref[WAS_LIVE] === true)) return ref.granted;
	return undefined;
}
