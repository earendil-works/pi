// The lists plugin on a list's worker. The todos live in a table of the worker's store (every one kept), written and
// read by one local object, `Store`. A table has no watch, so the store keeps a live window itself: the newest 50
// todos, read when it goes live and changed after each write (it is the only writer). Each principal's `Todos` view
// adds todos as that principal, and gives the owner `clear`.

import {
	arr,
	bool,
	type Ctx,
	defineFacet,
	defineTable,
	eq,
	Item,
	int,
	local,
	method,
	num,
	obj,
	query,
	str,
	Todos,
} from "@todo/app/v1";

/** Every todo of the list, by its number. */
const Items = defineTable("todo.items", {
	version: 1,
	columns: { id: int(), text: str(), done: bool(), by: str(), at: num() },
	key: ["id"],
});

/** The newest todos first. */
const NEWEST = query(Items).orderBy((item) => item.id, "desc");

/** How many todos the live window holds. */
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
		// The newest todos, oldest first, and the next todo's number: read once when the store goes live, then kept here.
		const window = self.writable<Item[]>([]);
		let next = 1;
		self.open(
			async (ctx) => {
				const { items: newest } = await items.page(NEWEST, WINDOW, ctx);
				window.set([...newest].reverse());
				next = (newest[0]?.id ?? 0) + 1;
			},
			() => {},
		);
		return {
			items: self.derive([window], ([value]) => value),
			add: async ({ text, by }, ctx) => {
				const item = { id: next++, text, done: false, by, at: Date.now() };
				await self.tx(async (tx) => tx.put(items, item), ctx);
				// In number order: two adds may commit in either order.
				window.set([...window.value, item].sort((a, b) => a.id - b.id).slice(-WINDOW));
				return null;
			},
			tick: async ({ id, done }, ctx) => {
				await self.tx(async (tx) => tx.updateWhere(items, (item) => eq(item.id, id), { done }), ctx);
				window.set(window.value.map((item) => (item.id === id ? { ...item, done } : item)));
				return null;
			},
			clear: async (ctx) => {
				await self.tx(async (tx) => tx.deleteWhere(items, (item) => eq(item.done, true)), ctx);
				window.set(window.value.filter((item) => !item.done));
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
