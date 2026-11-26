// One checklist as every caller holding it reads it (`ChecklistRead`): its name and its items, read whole, once per
// checklist whoever holds it (a hundred holders are one read of its items, not a hundred). The read is bounded by
// `MAX_ITEMS`, which the store's `add` enforces, so it never hides an item. Each caller's object hands out its
// members (`server.ts`).

import { arr, type FacetHost, local, type P3Principal, str } from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import { Item, MAX_ITEMS } from "./kind.ts";
import { ChecklistStore } from "./store.ts";

/** One checklist as every caller holding it reads it: its name (its thing's, "" while it has none) and its items. */
export const ChecklistRead = local("checklist.read", {
	version: 1,
	params: { thing: str() },
	members: { name: str(), items: arr(Item) },
});

/** Serves `ChecklistRead` on `host`. */
export function serveRead(host: FacetHost<P3Principal>): void {
	host.serve(ChecklistRead, ({ thing }, self) => {
		const named = self.liveQuery(self.get(ThingsStore, {}).things.one, { thing }, { first: 1 });
		const found = self.liveQuery(self.get(ChecklistStore, {}).items.of, { checklist: thing }, { first: MAX_ITEMS });
		return {
			name: self.derive([named], ([{ rows }]) => rows[0]?.name ?? ""),
			items: self.derive([found], ([{ rows }]) => rows),
		};
	});
}
