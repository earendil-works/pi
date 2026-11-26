// The checklist on the server: its store (`store.ts`), one checklist as everyone holding it reads it
// (`ChecklistRead`), and the kind (`serveThing`). The things plugin makes, links, admits and deletes checklists; this
// file says what a checklist is for one caller: its name, its items, and the members Add and Tick give. Its items go
// when the thing goes (`delete`). One read per checklist, whoever holds it: a hundred people holding one checklist are
// one read of its items, not a hundred.

import { arr, defineFacet, type FacetHost, local, type P3Principal, str } from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { ChecklistKind, Item, MAX_ITEMS } from "./contract.ts";
import { ChecklistStore, serveStore } from "./store.ts";

/** One checklist as every caller holding it reads it: its name and its items, read whole. */
const ChecklistRead = local("checklist.read", {
	version: 1,
	params: { thing: str() },
	members: { name: str(), items: arr(Item) },
});

export default defineFacet((host) => {
	serveStore(host);
	serveRead(host);
	serveThing(host, ChecklistKind, {
		// A new checklist starts empty: nothing to set up. Its items go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(ChecklistStore, {})).clear({ checklist: thing }, ctx);
		},
		// One checklist for one caller. The things plugin admitted them and decides which members they get: `addItem`
		// only with Add, `setDone` only with Tick. Every caller gets the name and the items, the checklist's one read.
		implement: ({ thing }, _admitted, self) => {
			const store = self.get(ChecklistStore, {});
			const read = self.get(ChecklistRead, { thing });
			return {
				name: read.name,
				items: read.items,
				addItem: ({ text }, ctx) => store.add({ checklist: thing, text }, ctx),
				setDone: ({ id, done }, ctx) => store.tick({ checklist: thing, id, done }, ctx),
			};
		},
	});
});

/** Serves `ChecklistRead` on `host`. */
function serveRead(host: FacetHost<P3Principal>): void {
	host.serve(ChecklistRead, ({ thing }, self) => {
		const named = self.liveQuery(self.get(ThingsStore, {}).things.one, { thing }, { first: 1 });
		// Whole: a full checklist refuses a new item (`ChecklistStore.add`).
		const found = self.liveQuery(self.get(ChecklistStore, {}).items.of, { checklist: thing }, { first: MAX_ITEMS });
		return {
			name: self.derive([named], ([{ rows }]) => rows[0]?.name ?? ""),
			items: self.derive([found], ([{ rows }]) => rows),
		};
	});
}
