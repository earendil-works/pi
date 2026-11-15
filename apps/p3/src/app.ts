// What p3 tells the kit about itself, shared by the server, the worker entry and the tests: its API (name, versions,
// this process's instances of the modules), its facet kinds, its principals and who may reach a session's worker.

import type { Address } from "@earendil-works/chord";
import * as v1 from "@p3/app/v1";
import * as v1server from "@p3/app/v1/server";
import * as v1worker from "@p3/app/v1/worker";
import type { P3Principal } from "./principals.ts";

/** p3's API: its package, its versions (newest first) and this process's modules by specifier. */
export const API = {
	name: "@p3/app",
	versions: ["v1"],
	modules: { "@p3/app/v1": v1, "@p3/app/v1/server": v1server, "@p3/app/v1/worker": v1worker },
};

/** p3's facet kinds: a plugin has one file per kind it runs on (`server.ts`, `worker.ts`). */
export const KINDS = { server: { platform: "node" }, worker: { platform: "node" } } as const;

/** p3's principals as the kit stamps them: the server's, a session worker's, the owner's. */
export const PRINCIPALS: {
	readonly server: P3Principal;
	readonly worker: (address: Address) => P3Principal;
	readonly owner: P3Principal;
} = {
	server: { kind: "server" },
	worker: (address) => ({ kind: "worker", session: String(address.params.id) }),
	owner: { kind: "owner" },
};

/** Who may reach a session's worker: the owner and the server (persons come with admission, slice 5). */
export function mayReachSession(principal: P3Principal): boolean {
	return principal.kind === "owner" || principal.kind === "server";
}
