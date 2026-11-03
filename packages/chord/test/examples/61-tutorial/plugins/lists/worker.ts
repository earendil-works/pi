// The lists plugin on a list's worker. The todos live in a table of the worker's store (every one kept), written and
// read by one local object, `Store`, which shows the newest 50 live with a live query (`self.query`): Chord runs it
// before the store goes live and again after every commit that writes the table. Each principal's `Todos` view adds
// todos as that principal, and gives the owner `clear`. The store refuses a todo without text with Chord's
// `invalid/args`.

import {
	arr,
	bool,
	type Ctx,
	defineFacet,
	defineTable,
	eq,
	int,
	invalid,
	local,
	method,
	num,
	obj,
	query,
	str,
} from "@todo/app/v1";
import { Item, Todos } from "./contract.ts";

/** Every todo of the list, by its number. */
const Items = defineTable("todo.items", {
	version: 1,
	columns: { id: int(), text: str(), done: bool(), by: str(), at: num() },
	key: ["id"],
});

/** The newest todos first. */
const NEWEST = query(Items).orderBy((item) => item.id, "desc");

/** How many todos the live query holds. */
const WINDOW = 50;

/** The list's todos, once per worker: empty params, so it lives as long as the worker and may keep data in its store. */
const Store = local("todo.store", {
	version: 1,
	params: {},
	members: {
		items: arr(Item),
		add: method(obj({ text: str(), by: str() })),
		tick: method(obj({ id: int(), done: bool() })),
		clear: method(),
	},
});

export default defineFacet((host) => {
	host.serve(Store, (_params, self) => {
		const items = self.table(Items);
		// The newest todos, live: read before the store goes live, read again after every commit writing the table.
		const newest = self.query(items, NEWEST, WINDOW);
		return {
			// Oldest first, as the list shows them.
			items: self.derive([newest], ([rows]) => [...rows].reverse()),
			add: async ({ text, by }, ctx) => {
				// Refused as Chord refuses arguments that fail their schema: the caller gets `invalid/args`.
				if (text === "") throw invalid("args", "a todo needs text");
				await self.tx(async (tx) => {
					// The number after the newest todo's: the store's transactions run one after another.
					const { items: last } = await tx.page(items, NEWEST, 1);
					tx.put(items, { id: (last[0]?.id ?? 0) + 1, text, done: false, by, at: Date.now() });
				}, ctx);
				return null;
			},
			tick: async ({ id, done }, ctx) => {
				await self.tx(async (tx) => tx.updateWhere(items, (item) => eq(item.id, id), { done }), ctx);
				return null;
			},
			clear: async (ctx) => {
				await self.tx(async (tx) => tx.deleteWhere(items, (item) => eq(item.done, true)), ctx);
				return null;
			},
		};
	});
	host.serve(Todos, (_params, principal, self) => {
		const store = self.get(Store, {});
		// Who adds a todo comes from the principal the link stamped, never from the arguments.
		const by = principal.kind === "user" ? principal.name : principal.kind;
		const members = {
			items: self.derive([store.items], ([items]) => items),
			add: (text: string, ctx: Ctx) => store.add({ text, by }, ctx),
			tick: (tick: { id: number; done: boolean }, ctx: Ctx) => store.tick(tick, ctx),
		};
		if (principal.kind !== "owner") return { variant: "member", members };
		return { variant: "owner", members: { ...members, clear: (ctx: Ctx) => store.clear(ctx) } };
	});
});
