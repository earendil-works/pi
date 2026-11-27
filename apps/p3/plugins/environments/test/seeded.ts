// A kind's seeded thing for the tests of the plugins that reach machines: the store makes it in Pi at its start, so a
// test that reads `OneThing` right after the start waits until it names one.

import { type Context, type Reference, until } from "@earendil-works/p3/v1";
import type { OneThing } from "../../things/contract.server.ts";

/** The id `one` names, once the store made the thing. */
export function seeded(one: Reference<typeof OneThing>, context: Context): Promise<string> {
	return until(one.thing, (id) => id !== "", context);
}
