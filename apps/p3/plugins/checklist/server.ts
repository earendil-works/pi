// The checklist on the server: its store (`store.ts`), the read every holder of a checklist shares (`read.ts`), and
// the kind (`serveThing`). The things plugin makes, links, admits and deletes checklists; this file says what a
// checklist is for one caller: its name and items (the shared read's), and the members Add and Tick give. Its items
// go when the thing goes (`delete`).

import { defineFacet } from "@earendil-works/p3/v1";
import { serveThing } from "../things/serve.ts";
import { ChecklistKind } from "./kind.ts";
import { ChecklistRead, serveRead } from "./read.ts";
import { ChecklistStore, serveStore } from "./store.ts";

export default defineFacet((host) => {
	serveStore(host);
	serveRead(host);
	serveThing(host, ChecklistKind, {
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
		// A new checklist starts empty: nothing to create. Its items go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(ChecklistStore, {})).clear({ checklist: thing }, ctx);
		},
	});
});
