// What p3 is to its base and its tests: its API (the package and its versions), its facet kinds, and its principals as
// links stamp them. The API's modules each process evaluates plugins with are `modules-server.ts` and
// `modules-worker.ts`: a worker never loads the server's (its HTTP stack).

import type { P3Principal } from "./principals.ts";

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
