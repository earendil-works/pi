// The notes plugin's contract (its facets are not part of this example: a test of the stats plugin stubs them).

import { local, str } from "@acme/app/v3";

/** A project's notes, as one text. */
export const Notes = local("acme.notes", { version: 1, params: { project: str() }, members: { text: str() } });
