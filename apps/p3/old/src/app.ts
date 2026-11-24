// What p3 is to its kit, its entries and its tests: its name, its API (the package, its versions, this process's
// instances of the modules), its facet kinds and its principals as links stamp them.

import type { Address } from "@earendil-works/chord";
import * as v1 from "@earendil-works/p3/v1";
import * as v1server from "@earendil-works/p3/v1/server";
import * as v1worker from "@earendil-works/p3/v1/worker";
import type { P3Principal } from "./principals.ts";

/** p3's name: its default data directory is `~/.pi/p3`. */
export const NAME = "p3";

/** p3's API: its package, its versions (newest first) and this process's modules by specifier. */
export const API = {
	name: "@earendil-works/p3",
	versions: ["v1"],
	modules: {
		"@earendil-works/p3/v1": v1,
		"@earendil-works/p3/v1/server": v1server,
		"@earendil-works/p3/v1/worker": v1worker,
	},
};

/** p3's facet kinds: a plugin has one file per kind it runs on (`server.ts`, `worker.ts`). */
export const KINDS = { server: { platform: "node" }, worker: { platform: "node" } } as const;

/** p3's principals as links stamp them: the server's, a session worker's, the owner's. */
export const PRINCIPALS: {
	readonly server: P3Principal;
	readonly worker: (address: Address<typeof v1.Session>) => P3Principal;
	readonly owner: P3Principal;
} = {
	server: { kind: "server" },
	worker: (address) => ({ kind: "worker", session: address.params.id }),
	owner: { kind: "owner" },
};
