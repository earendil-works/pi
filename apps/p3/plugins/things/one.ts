// `OneThing`: a kind's seeded thing (`serveThing`'s `one`) for server code of any plugin, live: the thing its plugin
// made of the kind, as the store's named query by maker finds it. The store makes it (in Pi, at its start and again
// at once whenever it is deleted); this object only follows what is on disk.

import type { FacetHost, P3Principal } from "@earendil-works/p3/v1";
import { OneThing, ThingHooks, ThingsStore } from "./contract.server.ts";
import { sourceKey } from "./contract.ts";

/** Serves `OneThing` on `host`: the id of the thing the kind's plugin made of it (`""` while none exists). */
export function serveOne(host: FacetHost<P3Principal>): void {
	host.serve(OneThing, ({ kind }, self) => {
		const hooks = self.registry(ThingHooks);
		const store = self.get(ThingsStore, {});
		// The plugin that serves the kind: its source key, the maker the query searches for.
		const maker = self.derive([hooks], ([table]) => ({
			sourceKey: sourceKey({ kind: "plugin", plugin: table.get(kind)?.plugin ?? "" }),
			kind,
		}));
		const made = self.liveQuery(store.things.ofMaker, maker, { first: 1 });
		return { thing: self.derive([made], ([page]) => page.rows[0]?.thing ?? "") };
	});
}
