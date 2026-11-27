// What p3 is to its base, its API and its tests: its API (the package and its versions), its facet kinds, and its
// principals (decisions "The principal is identity only", 2026-11-13, and "The owner is a person", 2026-11-22): who
// someone is, never what they may do. What a person may do, being the owner among it, is data of apps and plugins,
// read live by admissions. The API's modules ship this file.

import { lit, obj, type Static, str, union } from "@earendil-works/chord";

/**
 * Who someone is in p3: a person (an owner is one: their row in the things store has the owner flag), a session's worker, or
 * the server.
 */
export const P3Principal = union([
	obj({ kind: lit("person"), id: str(), name: str() }),
	obj({ kind: lit("worker"), session: str() }),
	obj({ kind: lit("server") }),
]);

/** Who someone is in p3 (see `P3Principal`). */
export type P3Principal = Static<typeof P3Principal>;

/** p3's API: its package and its versions (newest first). */
export const API = { name: "@earendil-works/p3", versions: ["v1"] } as const;

/**
 * The facet kinds a plugin may have: one file per kind (`server.ts`, `worker.ts`, `web.tsx`), each with its host
 * packages. A web facet gets React and Elanor from the page (one instance each, the versions p3 ships), so a third
 * party's plugin type-checks against them and inlines neither. Icons are not a host package: the whole set would be
 * 695 KB gzipped in every page; `/v1/web` re-exports the icons p3 offers by name.
 */
export const KINDS = {
	server: { platform: "node", hostPackages: ["@earendil-works/p3/v1", "@earendil-works/p3/v1/server"] },
	worker: { platform: "node", hostPackages: ["@earendil-works/p3/v1", "@earendil-works/p3/v1/worker"] },
	web: {
		platform: "browser",
		hostPackages: [
			"@earendil-works/p3/v1",
			"@earendil-works/p3/v1/web",
			"react",
			"react/jsx-runtime",
			"@earendil-works/elanor-react",
		],
	},
} as const;

/** The server's principal. */
export const SERVER: P3Principal = { kind: "server" };

/** The principal of session `id`'s worker. */
export function workerPrincipal(id: string): P3Principal {
	return { kind: "worker", session: id };
}

/**
 * A caller as a params value (params are flat strings): `server`, `person:<id>`, `worker:<session>`. The
 * sessions plugin's access answer is asked by it; nothing else turns a principal into data.
 */
export function callerKey(principal: P3Principal): string {
	switch (principal.kind) {
		case "server":
			return principal.kind;
		case "person":
			return `person:${principal.id}`;
		case "worker":
			return `worker:${principal.session}`;
	}
}
