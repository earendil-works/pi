// The checklist on the server: its items (a table keyed by the checklist's thing id), the store that owns them, and
// the kind with its object (`serveThing`). The store is used only here (and by the query plans' test), so its contract
// lives here too.

import {
	bool,
	defineFacet,
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
import { serveThing } from "@earendil-works/p3/v1/server";
import { Checklist, ChecklistKind, Item } from "./contract.ts";

/** How many items a checklist holds at most: its object reads them whole. */
const LIMIT = 500;

/** The items of every checklist, and their writes; a checklist is its thing's id. Exported for the query plans' test. */
export const ChecklistStore = local("checklist.store", {
	version: 1,
	params: {},
	members: {
		items: queries(Item, {
			/** Checklist `checklist`'s items, in the order they were added. */
			of: obj({ checklist: str() }),
		}),
		/** Adds an item, not done; answers its id. Refused once the checklist holds `LIMIT` items. */
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

export default defineFacet((host) => {
	serveStore(host);
	serveThing(host, ChecklistKind, {
		title: "Checklist",
		creation: "content",
		// A new checklist starts empty; its items go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(ChecklistStore, {})).clear({ checklist: thing }, ctx);
		},
		object: {
			contract: Checklist,
			factory: ({ thing }, { access, options }, self) => {
				const store = self.get(ChecklistStore, {});
				const found = self.liveQuery(store.items.of, { checklist: thing }, { first: LIMIT });
				const reader = { items: self.derive([found], ([{ rows }]) => rows) };
				// The kind's one rule: a reader only reads; a writer ticks (and adds) only if the option allows it.
				if (access === "read" || !options.check) return { variant: "reader", members: reader };
				return {
					variant: "checker",
					members: {
						...reader,
						add: ({ text }, ctx) => store.add({ checklist: thing, text }, ctx),
						tick: ({ id, done }, ctx) => store.tick({ checklist: thing, id, done }, ctx),
					},
				};
			},
		},
	});
});

/** Serves `ChecklistStore` on `host`. */
function serveStore(host: FacetHost<P3Principal>): void {
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
					// A full checklist refuses, so its object, which reads `LIMIT` items, never hides one.
					const held = await count(tx, checklist);
					if (held >= LIMIT) throw invalid("args", `checklist: a checklist holds ${LIMIT} items`);
					tx.put(items, { checklist, id, text, done: false, seq: held + 1 });
					return null;
				}, ctx);
				return id;
			},
			tick: ({ checklist, id, done }, ctx) =>
				self.tx(async (tx) => {
					if ((await tx.get(items, { checklist, id })) === undefined) {
						throw invalid("args", `checklist: ${checklist} has no item ${id}`);
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
