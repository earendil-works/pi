// What p3 is to its base, its API and its tests: its API (the package and its versions), its facet kinds, and its
// principals (decision "The principal is identity only", 2026-11-13): who someone is, never what they may do. What a
// person may do is data of apps and plugins, read live by admissions. The API's modules ship this file.

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

/** p3's API: its package and its versions (newest first). */
export const API = { name: "@earendil-works/p3", versions: ["v1"] } as const;

/** The facet kinds a plugin may have: one file per kind (`server.ts`, `worker.ts`), each with its API modules. */
export const KINDS = {
	server: { platform: "node", hostPackages: ["@earendil-works/p3/v1", "@earendil-works/p3/v1/server"] },
	worker: { platform: "node", hostPackages: ["@earendil-works/p3/v1", "@earendil-works/p3/v1/worker"] },
} as const;

/** The server's principal. */
export const SERVER: P3Principal = { kind: "server" };

/** The principal of session `id`'s worker. */
export function workerPrincipal(id: string): P3Principal {
	return { kind: "worker", session: id };
}
