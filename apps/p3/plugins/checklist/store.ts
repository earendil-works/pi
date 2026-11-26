// The checklist store on the server (`ChecklistStore`): every checklist's items, keyed by the checklist's thing id (the
// thing itself, its name and where it is linked are the things plugin's), its named query, and every write. A
// checklist's items live as long as its thing: its kind's `delete` clears them.

import {
	bool,
	defineTable,
	eq,
	type FacetHost,
	int,
	invalid,
	local,
	method,
	obj,
	type P3Principal,
	queries,
	query,
	str,
	type Tx,
} from "@earendil-works/p3/v1";
import { Item, MAX_ITEMS } from "./kind.ts";
import { messages } from "./messages.ts";

/**
 * The items of every checklist, and their writes; a checklist is its thing's id. Server code of this plugin only: it
 * checks no caller (`Checklist` admits them).
 */
export const ChecklistStore = local("checklist.store", {
	version: 1,
	params: {},
	members: {
		items: queries(Item, {
			/** Checklist `checklist`'s items, in the order they were added. */
			of: obj({ checklist: str() }),
		}),
		/** Adds an item, not done; answers its id. Refused once the checklist holds `MAX_ITEMS` items. */
		add: method(obj({ checklist: str(), text: str() }), str()),
		/** Marks item `id` done or not; refused for an item the checklist does not have. */
		tick: method(obj({ checklist: str(), id: str(), done: bool() })),
		/** Removes every item of a checklist (its thing is gone). */
		clear: method(obj({ checklist: str() })),
	},
});

/** Every checklist's items. Index `by_order`: a checklist's items in the order they were added (`seq`). */
const Items = defineTable("checklist.items", {
	version: 1,
	columns: { checklist: str(), id: str(), text: str(), done: bool(), seq: int() },
	key: ["checklist", "id"],
	indexes: { by_order: ["checklist", "seq"] },
});

/** Serves `ChecklistStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(ChecklistStore, (_params, self) => {
		const items = self.table(Items);
		/**
		 * How many items checklist `checklist` holds: its last item's `seq` (items are numbered from 1 and never removed
		 * one by one), one row of index `by_order`.
		 */
		const count = async (tx: Tx, checklist: string) => {
			const newest = query(Items)
				.where((item) => eq(item.checklist, checklist))
				.orderBy((item) => item.seq, "desc");
			return (await tx.page(items, newest, 1)).items[0]?.seq ?? 0;
		};
		return {
			items: self.queries(
				items,
				{ map: ({ id, text, done }) => ({ id, text, done }), reads: ["id", "text", "done"] },
				{
					// Index `by_order`: `checklist` fixed, in the order of `seq`, then the key.
					of: ({ checklist }: { checklist: string }) =>
						query(Items)
							.where((item) => eq(item.checklist, checklist))
							.orderBy((item) => item.seq, "asc"),
				},
			),
			add: async ({ checklist, text }, ctx) => {
				const id = crypto.randomUUID();
				await self.tx(async (tx) => {
					// A full checklist refuses, so its readers, which read `MAX_ITEMS` items, never miss one.
					const held = await count(tx, checklist);
					if (held >= MAX_ITEMS) {
						throw invalid("args", `checklist: a checklist holds ${MAX_ITEMS} items`, {
							message: messages.message("full", MAX_ITEMS),
						});
					}
					tx.put(items, { checklist, id, text, done: false, seq: held + 1 });
					return null;
				}, ctx);
				return id;
			},
			tick: ({ checklist, id, done }, ctx) =>
				self.tx(async (tx) => {
					if ((await tx.get(items, { checklist, id })) === undefined) {
						throw invalid("args", `checklist: ${checklist} has no item ${id}`, {
							message: messages.message("noItem"),
						});
					}
					tx.update(items, { checklist, id }, { done });
					return null;
				}, ctx),
			clear: ({ checklist }, ctx) =>
				self.tx(async (tx) => {
					// The key's prefix `checklist`: one statement.
					tx.deleteWhere(items, (item) => eq(item.checklist, checklist));
					return null;
				}, ctx),
		};
	});
}
