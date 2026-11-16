// Named queries (slice 14 §3): a store offers queries under names, with the schema of each one's arguments in its
// contract. Any object on the store's host reads one live with `self.liveQuery(query, args, { first })`: its member
// is `{ rows, more }`, run before the reader is live and again, inside the commit step, by every commit that can
// change it. Arguments may follow a value. `self.count` is the exact number of rows, and expensive: every run reads
// every matching row. `page` reads without a live read.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/70-named-queries.ts
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, withTelemetry } from "../../src/context/index.ts";
import { arr, bool, int, local, method, obj, queries, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { defineTable, eq, openStore, query, sqliteBackend } from "../../src/store/index.ts";

// The store's contract lists its queries: readers get typed arguments, and a changed schema is a changed contract.
const Task = obj({ id: int(), title: str(), done: bool() });
const Tasks = local("example.tasks", {
	version: 1,
	params: {},
	members: {
		tasks: queries(Task, { ofList: obj({ list: str() }), one: obj({ id: int() }) }),
		put: method(obj({ id: int(), list: str(), title: str() })),
		finish: method(int()),
		note: method(obj({ id: int(), note: str() })),
	},
});

const Rows = defineTable("example.task-rows", {
	version: 1,
	columns: { id: int(), list: str(), title: str(), done: bool({ default: false }), note: str({ default: "" }) },
	key: ["id"],
	// The index `ofList` runs on: its condition's column, then its order.
	indexes: { by_list: ["list", "id"] },
});

// The store's plugin: one builder per listed query, a pure function of its arguments. `reads` lists the columns
//    the mapping gets: a change of another column (`note`) is no change of an item.
const storeFacet = defineFacet((h) =>
	h.serve(Tasks, (_, self) => {
		const rows = self.table(Rows);
		const tasks = self.queries(
			rows,
			{ map: (row) => ({ id: row.id, title: row.title, done: row.done }), reads: ["id", "title", "done"] },
			{
				ofList: ({ list }: { list: string }) =>
					query(Rows)
						.where((t) => eq(t.list, list))
						.orderBy((t) => t.id, "desc"),
				one: ({ id }: { id: number }) => query(Rows).where((t) => eq(t.id, id)),
			},
		);
		return {
			tasks,
			put: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(rows, row), ctx);
				return null;
			},
			// A writer names what it changes: an `update` tells readers which columns changed.
			finish: async (id, ctx) => {
				await self.tx(async (tx) => tx.update(rows, { id }, { done: true }), ctx);
				return null;
			},
			note: async ({ id, note }, ctx) => {
				await self.tx(async (tx) => tx.update(rows, { id }, { note }), ctx);
				return null;
			},
		};
	}),
);

// A reader in another plugin: the newest three tasks of the list it shows, and how many there are. Its arguments
//    follow `shown`: when it changes, the member keeps the previous rows until the new read has run.
const Board = local("example.board", {
	version: 1,
	params: {},
	members: { newest: obj({ rows: arr(Task), more: bool() }), total: int(), show: method(str()) },
});

const boardFacet = defineFacet((h) =>
	h.serve(Board, (_, self) => {
		const store = self.get(Tasks, {});
		const shown = self.writable("home");
		const args = self.derive([shown], ([list]) => ({ list }));
		return {
			newest: self.liveQuery(store.tasks.ofList, args, { first: 3 }),
			// Exact and uncapped: count what an index bounds.
			total: self.count(store.tasks.ofList, args),
			show: async (list) => {
				shown.set(list);
				return null;
			},
		};
	}),
);

// Work counts through the context of the call that causes it: this one records in memory.
const telemetry = new InMemoryTelemetryContext();
const context = withTelemetry(await telemetry.startSpan({ name: "example" }, (span) => span), BACKGROUND_CONTEXT);
const counter = (name: string): number =>
	telemetry
		.getMetrics()
		.filter((metric) => metric.name === name)
		.reduce((sum, metric) => sum + metric.value, 0);
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const host = createHost({ store, telemetry, onError: (error) => console.error(error) });
await host.load(
	[
		{ name: "@example/tasks", facet: storeFacet },
		{ name: "@example/board", facet: boardFacet },
	],
	context,
);
const tasks = await host.get(Tasks, {}, context);
const board = await host.get(Board, {}, context);

for (const [id, list] of [
	[1, "home"],
	[2, "home"],
	[3, "work"],
	[4, "home"],
	[5, "home"],
	[7, "home"],
	[8, "home"],
] as const) {
	await tasks.put({ id, list, title: `task ${id}` }, context);
}
// 1. The reader's first rows were read before it went live.
const titles = (): string => board.newest.value.rows.map((task) => `${task.id}${task.done ? "✓" : ""}`).join(" ");
console.log("1. newest of home:", titles(), "| more:", board.newest.value.more, "| total:", board.total.value);

// 2. What a commit costs the readers: nothing, one keyed probe, or one run.
const cost = async (what: string, write: () => Promise<unknown>): Promise<void> => {
	const before = ["chord.query.runs", "chord.query.probes", "chord.query.skips"].map(counter);
	await write();
	const [runs, probes, skips] = ["chord.query.runs", "chord.query.probes", "chord.query.skips"].map(
		(name, index) => counter(name) - before[index]!,
	);
	console.log(`   ${what}: ${runs} runs, ${probes} probes, ${skips} skipped`);
};
console.log("2. two reads are open (the list and the count):");
await cost("a note on task 8 (a column neither depends on)", () => tasks.note({ id: 8, note: "call back" }, context));
await cost("task 8 finished (a mapped column of a row in the list)", () => tasks.finish(8, context));
await cost("task 1 finished (not among the list's rows, and it cannot enter)", () => tasks.finish(1, context));
await cost("a new task at the list's end (the probe asks; the count keeps no rows and runs)", () =>
	tasks.put({ id: 0, list: "home", title: "task 0" }, context),
);
console.log("   newest of home:", titles());

// 3. The arguments follow a value: the list switches in one frame, from the rows of one list to the rows of the other.
const watch = await board.newest.watch(context);
watch.start(async (call) => {
	console.log("3. one frame:", call.kind === "value" ? titles() : call.kind);
});
await board.show("work", context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("   total of work:", board.total.value);
watch.stop();

// 4. A page at a time, not live: for jobs and scripts.
const first = await tasks.tasks.ofList.page({ list: "home" }, 2, context);
const second = await tasks.tasks.ofList.page({ list: "home" }, 2, context, { after: first.next! });
console.log(
	"4. pages:",
	first.items.map((task) => task.id),
	second.items.map((task) => task.id),
);

board.release();
tasks.release();
await host.close(context);
await store.close(context);
