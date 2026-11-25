// p3's principals (decision "The principal is identity only", 2026-11-13): who someone is, never what they may do.
// What a person may do is data of apps and plugins, read live by admissions.

import { lit, obj, type Static, str, union } from "@earendil-works/chord";

/** Who someone is in p3: the owner, a person the owner let in, a session's worker, or the server. */
export const P3Principal = union([
	obj({ kind: lit("owner") }),
	obj({ kind: lit("person"), id: str(), name: str() }),
	obj({ kind: lit("worker"), session: str() }),
	obj({ kind: lit("server") }),
]);

/** Who someone is in p3 (see `P3Principal`). */
export type P3Principal = Static<typeof P3Principal>;
