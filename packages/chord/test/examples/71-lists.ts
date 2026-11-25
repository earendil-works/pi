// Lists (slice 14 §4): `self.list(name, [[namedQuery, args]], { first })` is a named query a screen loads more of.
// Its pages tile the query's order between fixed bookmarks, each page one read the store keeps current. So: loaded
// rows stay live; "load more" sends only the new rows; a row that moves to the top (a list by last touch) leaves one
// page and enters another in the same commit, with no gap and no duplicate; the last page is open while no row is
// known behind it; a reload of the list's plugin opens the pages it had.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/71-lists.ts
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, bool, int, local, method, obj, queries, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { defineTable, eq, openStore, query, sqliteBackend } from "../../src/store/index.ts";

// A store of a session's subagents, and the query a list reads: one session's, the newest touched first.
const Child = obj({ id: int(), name: str(), lastTouch: int() });
const Children = local("example.children", {
	version: 1,
	params: {},
	members: {
		children: queries(Child, { ofSession: obj({ session: str() }) }),
		spawn: method(obj({ session: str(), count: int() })),
		message: method(int()),
	},
});
const ChildRows = defineTable("example.child-rows", {
	version: 1,
	columns: { id: int(), session: str(), name: str(), lastTouch: int() },
	key: ["id"],
	// The index `ofSession` runs on: its condition's column, then its order.
	indexes: { of_session: ["session", "lastTouch"] },
});

let clock = 0;
let nextId = 0;
const storeFacet = defineFacet((h) =>
	h.serve(Children, (_, self) => {
		const rows = self.table(ChildRows);
		return {
			children: self.queries(
				rows,
				{ map: ({ id, name, lastTouch }) => ({ id, name, lastTouch }), reads: ["id", "name", "lastTouch"] },
				{
					ofSession: ({ session }: { session: string }) =>
						query(ChildRows)
							.where((c) => eq(c.session, session))
							.orderBy((c) => c.lastTouch, "desc"),
				},
			),
			spawn: async ({ session, count }, ctx) => {
				await self.tx(async (tx) => {
					for (let index = 0; index < count; index++) {
						tx.put(rows, { id: ++nextId, session, name: `agent ${nextId}`, lastTouch: ++clock });
					}
				}, ctx);
				return null;
			},
			// A message touches its child: an `update` of the column that changes.
			message: async (id, ctx) => {
				await self.tx(async (tx) => tx.update(rows, { id }, { lastTouch: ++clock }), ctx);
				return null;
			},
		};
	}),
);

// One list object per screen: `view` is the screen's own id (a fresh id is a fresh list). Its state member is
//    `{ rows, moreAfter }`, its method `more` loads the next page.
const Subagents = local("example.subagents", {
	version: 1,
	params: { session: str(), view: str() },
	members: { list: obj({ rows: arr(Child), moreAfter: bool() }), more: method() },
});
const listFacet = () =>
	defineFacet((h) =>
		h.serve(Subagents, ({ session }, self) => {
			const list = self.list("children", [[self.get(Children, {}).children.ofSession, { session }]], { first: 4 });
			return { list: list.value, more: (ctx) => list.more(ctx) };
		}),
	);

const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const host = createHost({ store, onError: (error) => console.error(error) });
const storePlugin = { name: "@example/children", facet: storeFacet };
await host.load([storePlugin, { name: "@example/list", facet: listFacet() }], context);
const children = await host.get(Children, {}, context);
await children.spawn({ session: "s1", count: 10 }, context);

// 1. A screen holds its list: the first page, and whether rows may follow.
const screen = await host.get(Subagents, { session: "s1", view: "tab-1" }, context);
const shown = (): string => {
	const { rows, moreAfter } = screen.list.value;
	return `${rows.map((child) => child.id).join(" ")}${moreAfter ? " …" : ""}`;
};
console.log("1. the first page:", shown());

// 2. `more` adds one page. The rows already loaded are the same objects: a hold over a link gets only the new ones.
const loaded = screen.list.value.rows;
await screen.more(context);
console.log("2. after more:    ", shown(), "| loaded rows kept:", screen.list.value.rows[0] === loaded[0]);

// 3. A child in the second page gets a message and moves to the top. It leaves its page's range and enters the first
//    page's in the same commit: one frame, the list never without it and never with it twice.
const watch = await screen.list.watch(context);
watch.start(async (call) => {
	console.log("3. one frame:     ", call.kind === "value" ? shown() : call.kind);
});
await children.message(5, context);
await new Promise((resolve) => setTimeout(resolve, 5));

//    A child nobody loaded yet gets a message: it enters the first page too. A new child appears at the top.
await children.message(1, context);
await children.spawn({ session: "s1", count: 1 }, context);
await new Promise((resolve) => setTimeout(resolve, 5));
watch.stop();

// 4. A reload of the list's plugin: the successor opens the pages the list had (its bookmarks are the object's).
await host.reload([storePlugin, { name: "@example/list", facet: listFacet() }], context);
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("4. after a reload:", shown());

// 5. To the end: the last page is open while no row is behind it, so a child spawned later appears by itself.
while (screen.list.value.moreAfter) await screen.more(context);
console.log("5. everything:    ", shown());

screen.release();
children.release();
await host.close(context);
await store.close(context);
