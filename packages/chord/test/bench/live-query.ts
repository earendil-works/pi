// Benchmark of live queries (decision "Live queries over an object's own tables"): the cost of one commit that writes
// a table with a live query of its newest 100 rows (a chat's window: a short text per row), against the same commit
// without the query, with the query unwatched (no diff) and a commit writing another table. Each step appends one row
// (the window shifts by one) in one transaction; the value is watched, as a client's hold watches it, except in the
// unwatched case. Median and p95 per commit over several bursts, on a SQLite `:memory:` store.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/bench/live-query.ts
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, int, local, method, num, obj, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { constant } from "../../src/state/index.ts";
import { defineTable, openStore, query, sqliteBackend } from "../../src/store/index.ts";

const STEPS = 2_000;
const RUNS = 7;
const WINDOW = 100;
const TEXT = "a message of about the length people type in a chat, give or take a few words";

const Messages = defineTable("messages", {
	version: 1,
	columns: { id: int(), author: str(), text: str(), at: num() },
	key: ["id"],
});
const Other = defineTable("other", { version: 1, columns: { id: int(), text: str() }, key: ["id"] });
const NEWEST = query(Messages).orderBy((message) => message.id, "desc");

const Message = obj({ id: int(), author: str(), text: str(), at: num() });
const Room = local("bench.room", {
	version: 1,
	params: {},
	members: { messages: arr(Message), post: method(int()), other: method(int()) },
});

/**
 * What a burst measures: a commit of `Messages` with the live query watched, unwatched, or without it, or a commit of
 * `Other` beside the watched query.
 */
type Kind = "no query" | "query" | "unwatched" | "other table";

/** Per-commit times (ms) of `RUNS` bursts of `STEPS` commits of `kind`, after one warm-up burst. */
async function bursts(kind: Kind): Promise<{ readonly median: number; readonly p95: number }> {
	const times: number[] = [];
	for (let run = -1; run < RUNS; run++) {
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
		const host = createHost({ store, onError: () => {} });
		const facet = defineFacet((h) =>
			h.serve(Room, (_, self) => {
				const messages = self.table(Messages);
				const other = self.table(Other);
				return {
					messages: kind === "no query" ? constant([]) : self.query(messages, NEWEST, WINDOW),
					post: async (id, ctx) => {
						await self.tx(async (tx) => tx.put(messages, { id, author: "ada", text: TEXT, at: id }), ctx);
						return null;
					},
					other: async (id, ctx) => {
						await self.tx(async (tx) => tx.put(other, { id, text: TEXT }), ctx);
						return null;
					},
				};
			}),
		);
		await host.load([{ name: "@bench/live-query", facet }], context);
		const room = await host.get(Room, {}, context);
		// A full window first: every later post shifts it by one row.
		for (let id = 1; id <= WINDOW; id++) await room.post(id, context);
		const watch = await room.messages.watch(context);
		if (kind === "unwatched") await watch.stop();
		else watch.start(async () => {});
		for (let step = 0; step < STEPS; step++) {
			const id = WINDOW + 1 + step;
			const before = performance.now();
			await (kind === "other table" ? room.other(id, context) : room.post(id, context));
			if (run >= 0) times.push(performance.now() - before);
		}
		await watch.stop();
		room.release();
		await host.close(context);
		await store.close(context);
	}
	times.sort((a, b) => a - b);
	return { median: times[Math.floor(times.length / 2)]!, p95: times[Math.floor(times.length * 0.95)]! };
}

for (const kind of ["no query", "query", "unwatched", "other table"] as const) {
	const { median, p95 } = await bursts(kind);
	console.log(
		`${kind.padEnd(12)} one-row commit through a call: ${(median * 1000).toFixed(1)} µs median, ${(p95 * 1000).toFixed(1)} µs p95`,
	);
}
