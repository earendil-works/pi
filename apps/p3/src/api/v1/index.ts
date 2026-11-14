// p3's API, version 1, for every host kind (`@p3/app/v1`): the part of Chord p3's plugins use, `defineFacet` typed with
// p3's principals, and p3's host kinds. Plugins import this module, never Chord: their builds leave it out and each
// process passes its own instance in.

import { defineFacet as chordFacet, type FacetHost, type FacetSelf, hostKind, str } from "@earendil-works/chord";
import type { P3Principal } from "../../principals.ts";

export type { P3Principal } from "../../principals.ts";

/** Defines a facet of p3: its factories get p3's principals. */
export function defineFacet(setup: (host: FacetHost<P3Principal>, self: FacetSelf) => void) {
	return chordFacet<P3Principal>(setup);
}

/** A session: a worker process of its own, with its own store. */
export const Session = hostKind("session", { id: str() });
