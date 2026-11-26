// The checklist on the server: its store (`store.ts`) and the kind (`serveThing`). The things plugin makes, links,
// admits and deletes checklists; this file says what a checklist is for one caller: its name and items, read whole
// (at most `MAX_ITEMS`, which the store's add enforces, so the read never hides one), and the members Add and Tick
// give. Each caller reads them with its own live queries; Chord shares identical reads (ERNDL-1176), so a hundred
// holders of one checklist are one read of its items. Its items go when the thing goes (`delete`).

import { defineFacet } from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { ChecklistKind, MAX_ITEMS } from "./kind.ts";
import { ChecklistStore, serveStore } from "./store.ts";

export default defineFacet((host) => {
	serveStore(host);
	serveThing(host, ChecklistKind, {
		// One checklist for one caller. The things plugin admitted them and decides which members they get: `addItem`
		// only with Add, `setDone` only with Tick. Every caller gets the name and the items.
		implement: ({ thing }, _admitted, self) => {
			const store = self.get(ChecklistStore, {});
			const named = self.liveQuery(self.get(ThingsStore, {}).things.one, { thing }, { first: 1 });
			const found = self.liveQuery(store.items.of, { checklist: thing }, { first: MAX_ITEMS });
			return {
				name: self.derive([named], ([{ rows }]) => rows[0]?.name ?? ""),
				items: self.derive([found], ([{ rows }]) => rows),
				addItem: ({ text }, ctx) => store.add({ checklist: thing, text }, ctx),
				setDone: ({ id, done }, ctx) => store.tick({ checklist: thing, id, done }, ctx),
			};
		},
		// A new checklist starts empty: nothing to create. Its items go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(ChecklistStore, {})).clear({ checklist: thing }, ctx);
		},
	});
});
