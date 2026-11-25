// The tally app's API, version 1 (`@tally/app/v1`): the part of Chord its plugins use, its host kind (a tally, one
// worker per tally) and the counter a tally's worker serves (clients hold it by its id; the server relays).

import { hostKind, int, method, remote, str } from "../../../../src/index.ts";

export { defineFacet, defineState, int, local, method, obj, str } from "../../../../src/index.ts";

/** A tally: its own worker process and store. */
export const Tally = hostKind("tally", { id: str() });

/** A tally's counter, served by its worker: the total, and `add` (a positive count; the new total). */
export const Counter = remote("tally.counter", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Tally({ id }),
	variants: { main: { state: { total: int() }, methods: { add: method(int(), int()) } } },
});
