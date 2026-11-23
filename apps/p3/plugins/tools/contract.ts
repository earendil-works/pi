// The tools plugin's contract: the coding tools (read, write, edit, and bash when `shell` is on) as a kind of thing a
// session can have. `/v1` re-exports it.

import { bool, obj } from "@earendil-works/p3/v1";
import { defineThing } from "../sessions/contract.ts";

/** The coding tools on the session's location; `shell: false` leaves bash out. */
export const CodingTools = defineThing("tools.coding", {
	version: 1,
	options: obj({ shell: bool() }),
	initial: { shell: true },
});
