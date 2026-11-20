// p3's API, version 1, for every host kind (`@earendil-works/p3/v1`): Chord's plugin surface re-exported once (so a
// plugin that needs one more of Chord's exports never forces an API change), `defineFacet` typed with p3's
// principals, p3's host kinds, and the kit's helpers for plugins (`forward`, `contribute`). Plugins import this
// module, never Chord: their builds leave it out and each process passes its own instance in.

import { defineFacet as chordFacet, type FacetHost, type FacetSelf, hostKind, str } from "@earendil-works/chord";
import type { P3Principal } from "../../../old/src/principals.ts";

// Everything of Chord's root; the names this module defines itself (`defineFacet`, `Server`, `Session`) win over a
// same-named export of Chord's.
export * from "@earendil-works/chord";
export { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
export { contribute } from "../../../old/src/kit/contribute.ts";
export { forward } from "../../../old/src/kit/forward.ts";
export type { P3Principal } from "../../../old/src/principals.ts";

/** Defines a facet of p3: its factories get p3's principals. */
export function defineFacet(setup: (host: FacetHost<P3Principal>, self: FacetSelf) => void) {
	return chordFacet<P3Principal>(setup);
}

/** The server: one per Pi. */
export const Server = hostKind("server");

/** A session: a worker process of its own, with its own store. */
export const Session = hostKind("session", { id: str() });
