// Benchmark of what a list keeps and what a commit costs it (the hot-path pass, 2026-11-26): the heap one list object
// adds with 20 pages of 50 rows loaded (a session's subagents by last touch, two columns read; `test/bench/slice-14.ts`'s
// list), measured over 30 lists after a warm-up of 5; then the median time of a message that moves the 500th loaded
// child to the top with all 35 lists open (in each the page it left and the first page run; every loaded row is
// decoded or reused in the frame),
// without slice-14's in-memory telemetry. On a SQLite `:memory:` store.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/bench/list-heap.ts
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, bool, int, local, method, obj, queries, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { defineTable, eq, openStore, query, sqliteBackend } from "../../src/store/index.ts";

const ChildRows = defineTable("children", {
	version: 1,
	columns: { id: int(), session: str(), lastTouch: int() },
	key: ["id"],
	indexes: { by_session: ["session", "lastTouch"] },
});
const Child = obj({ id: int(), lastTouch: int() });
const Children = local("bench.children", {
	version: 1,
	params: {},
	members: {
		children: queries(Child, { ofSession: obj({ session: str() }) }),
		spawn: method(int()),
		message: method(obj({ id: int(), at: int() })),
	},
});
const Subagents = local("bench.subagents", {
	version: 1,
	params: { view: str() },
	members: { list: obj({ rows: arr(Child), moreAfter: bool() }), more: method() },
});
const facet = defineFacet((h) => {
	h.serve(Children, (_, self) => {
		const rows = self.table(ChildRows);
		return {
			children: self.queries(
				rows,
				{ map: ({ id, lastTouch }) => ({ id, lastTouch }), reads: ["id", "lastTouch"] },
				{
					ofSession: ({ session }: { session: string }) =>
						query(ChildRows)
							.where((c) => eq(c.session, session))
							.orderBy((c) => c.lastTouch, "desc"),
				},
			),
			message: async ({ id, at }, ctx) => {
				await self.tx(async (tx) => tx.update(rows, { id }, { lastTouch: at }), ctx);
				return null;
			},
			spawn: async (count, ctx) => {
				await self.tx(async (tx) => {
					for (let id = 1; id <= count; id++) tx.put(rows, { id, session: "s", lastTouch: id });
				}, ctx);
				return null;
			},
		};
	});
	h.serve(Subagents, (_, self) => {
		const list = self.list("children", [[self.get(Children, {}).children.ofSession, { session: "s" }]], {
			first: 50,
		});
		return { list: list.value, more: (ctx) => list.more(ctx) as never };
	});
});
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const host = createHost({ store, onError: (e) => console.error(e) });
await host.load([{ name: "@bench/lists", facet }], context);
const children = await host.get(Children, {}, context);
await children.spawn(5_000, context);
const heap = async () => {
	for (let r = 0; r < 6; r++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		globalThis.gc!();
	}
	return process.memoryUsage().heapUsed;
};
const kept: unknown[] = [];
const open = async (from: number, count: number) => {
	for (let i = from; i < from + count; i++) {
		const screen = await host.get(Subagents, { view: `v${i}` }, context);
		for (let page = 1; page < 20; page++) await screen.more(context);
		kept.push(screen);
	}
};
await open(0, 5);
const before = await heap();
await open(5, 30);
console.log(`a list of 20 pages of 50 rows (2 columns): ${(((await heap()) - before) / 30 / 1024).toFixed(1)} KiB`);
const screen = kept[0] as { list: { value: { rows: { id: number }[] } } };
let at = 10_000;
const times: number[] = [];
for (let message = -100; message < 1_000; message++) {
	const id = screen.list.value.rows[500]!.id;
	const start = performance.now();
	await children.message({ id, at: ++at }, context);
	if (message >= 0) times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
console.log(`a message, 35 lists of 20 pages open: ${(times[times.length >> 1]! * 1000).toFixed(0)} us median`);
await host.close(context);
