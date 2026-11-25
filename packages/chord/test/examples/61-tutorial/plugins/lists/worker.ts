// The lists plugin on a list's worker. The todos live in a table of the worker's store (every one kept), written and
// read by one local object, `Store`, which shows the newest 50 live with a live query (`self.query`): Chord runs it
// before the store goes live and again after every commit that writes the table. Each principal's `Todos` view adds
// todos as that principal, and gives the owner `clear`, which leaves a notice: a message as data (`messages.message`),
// never a sentence, so each viewer reads it in its own language. The store refuses a todo without text with Chord's
// `invalid/args`, in a span of its own (`ctx.trace`) that the app's traces show.

import {
	arr,
	bool,
	type Ctx,
	defineFacet,
	defineState,
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
import { Item, Notice, Todos } from "./contract.ts";
import { messages } from "./messages.ts";

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

/** The list's latest notice (in memory: a notice is news, gone with the worker). */
const Notices = defineState("todo.notice", {
	schema: obj({ notice: Notice }),
	version: 1,
	initial: () => ({ notice: null }),
});

/** The list's todos, once per worker: empty params, so it lives as long as the worker and may keep data in its store. */
const Store = local("todo.store", {
	version: 1,
	params: {},
	members: {
		items: arr(Item),
		notice: Notice,
		add: method(obj({ text: str(), by: str() })),
		tick: method(obj({ id: int(), done: bool() })),
		clear: method(obj({ by: str() })),
	},
});

export default defineFacet((host) => {
	host.serve(Store, (_params, self) => {
		const items = self.table(Items);
		// The newest todos, live: read before the store goes live, read again after every commit writing the table.
		const newest = self.query(items, NEWEST, WINDOW);
		const notices = self.state(Notices);
		return {
			// Oldest first, as the list shows them.
			items: self.derive([newest], ([rows]) => [...rows].reverse()),
			notice: self.derive([notices], ([value]) => value.notice),
			add: async ({ text, by }, ctx) => {
				// A span of its own under the method's: a trace shows the check, and why it refused.
				await ctx.trace("todos.validate", { chars: text.length }, async () => {
					// Refused as Chord refuses arguments that fail their schema: the caller gets `invalid/args`.
					if (text === "") throw invalid("args", "a todo needs text");
				});
				await self.tx(async (tx) => {
					// The number after the newest todo's: the store's transactions run one after another.
					const { items: last } = await tx.page(items, NEWEST, 1);
					tx.put(items, { id: (last[0]?.id ?? 0) + 1, text, done: false, by, at: Date.now() });
				}, ctx);
				return null;
			},
			tick: async ({ id, done }, ctx) => {
				await self.tx(async (tx) => tx.update(items, { id }, { done }), ctx);
				return null;
			},
			clear: async ({ by }, ctx) => {
				await self.tx(async (tx) => tx.deleteWhere(items, (item) => eq(item.done, true)), ctx);
				// The key and its parameters, typed against the English catalog: every viewer renders its own text.
				await notices.change((draft) => {
					draft.notice = messages.message("cleared", by);
				}, ctx);
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
			notice: self.derive([store.notice], ([notice]) => notice),
			add: (text: string, ctx: Ctx) => store.add({ text, by }, ctx),
			tick: (tick: { id: number; done: boolean }, ctx: Ctx) => store.tick(tick, ctx),
		};
		if (principal.kind !== "owner") return { variant: "member", members };
		return { variant: "owner", members: { ...members, clear: (ctx: Ctx) => store.clear({ by }, ctx) } };
	});
});
