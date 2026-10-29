// Tables: an object's rows in the host's store, declared with `defineTable`, written in transactions (with the
// object's documents, if it has any), read by key, by page with cursors, and counted.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/20-tables.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, bool, int, local, method, obj, opt, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { add, defineTable, eq, openStore, prefix, query, sqliteBackend } from "../../../src/next/store/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// Flat columns (str, int, num, bool, opt(...), json(...)), defaults, a key of non-opt str or int columns, and
// indexes, which end with the key.
const Edits = defineTable("edits", {
	version: 1,
	columns: {
		id: str(),
		path: str(),
		at: int(),
		hits: int({ default: 0 }),
		done: bool({ default: false }),
		note: opt(str()),
	},
	key: ["id"],
	indexes: { by_path: ["path", "at"] },
});

const History = local("example.history", {
	version: 1,
	params: {},
	members: {
		record: method(obj({ id: str(), path: str(), at: int() })),
		hit: method(str()),
		finish: method(str()),
		hits: method(str(), int()),
		open: method(obj({ after: opt(str()) }), obj({ ids: arr(str()), next: opt(str()) })),
		finished: method(obj({}), int()),
	},
});

const facet = defineFacet((host) => {
	// Tables need a stable identity: a local type with empty params (one object per host).
	host.serve(History, (_, self) => {
		const edits = self.table(Edits);
		// A query of the table: a condition and an order (the key is the tie-break); immutable, built once.
		const open = query(Edits)
			.where((e) => eq(e.done, false))
			.orderBy((e) => e.at, "desc");
		return {
			record: async (row, ctx) => {
				// Writes are staged synchronously (a bad row throws here) and commit together in one step.
				await self.tx(async (tx) => tx.put(edits, row), ctx);
				return null;
			},
			hit: async (id, ctx) => {
				// A set is values or an expression over the row's columns, computed by the store.
				await self.tx(async (tx) => tx.update(edits, { id }, (e) => ({ hits: add(e.hits, 1) })), ctx);
				return null;
			},
			finish: async (path, ctx) => {
				// One statement for every matching row; its count is recorded with the write.
				await self.tx(async (tx) => tx.updateWhere(edits, (e) => prefix(e.path, path), { done: true }), ctx);
				return null;
			},
			hits: async (id, ctx) => (await edits.get({ id }, ctx))?.hits ?? 0,
			open: async ({ after }, ctx) => {
				const page = await edits.page(open, 1, ctx, after === undefined ? {} : { after });
				return { ids: page.items.map((row) => row.id), ...(page.next === undefined ? {} : { next: page.next }) };
			},
			finished: async (_, ctx) =>
				edits.count(
					query(Edits).where((e) => eq(e.done, true)),
					ctx,
				),
		};
	});
});

// A store over SQLite (`:memory:` here, a file in an app): the app opens it, gives it to one host, and closes it.
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const host = createHost({ store, onError: (error) => console.error("background error:", error) });
await host.load([{ name: "@example/history", facet }], context);
const history = await host.get(History, {}, context);

for (let i = 0; i < 5; i++) {
	await history.record({ id: `e${i}`, path: `src/${i % 2 === 0 ? "a" : "b"}.ts`, at: i }, context);
}
await history.hit("e1", context);
await history.hit("e1", context);
await history.finish("src/a", context);

console.log("hits of e1:", await history.hits("e1", context));
// Pages continue from an opaque cursor.
const first = await history.open({}, context);
console.log("open, first page:", first.ids);
console.log("open, next page:", (await history.open({ after: first.next }, context)).ids);
console.log("finished:", await history.finished({}, context));

await host.close(context);
await store.close(context);
