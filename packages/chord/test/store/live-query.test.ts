// Tests of live queries (decision "Live queries over an object's own tables"): `self.query(table, q, limit)` runs
// before its object goes live, again in the commit step of every commit of the object that writes its table, and
// publishes the diff in that commit's batch; a commit writing another table runs none; a reload restarts the object;
// the limit is required; a failing run is a failed member; an ended attempt's query is collected; a refresh applied
// again adopts only its last runs.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, int, local, method, obj, opt, str } from "../../src/contracts/index.ts";
import type { ChordError } from "../../src/data/index.ts";
import { createHost, defineFacet, type FacetHost, type HostError, type StoreSelf } from "../../src/host/index.ts";
import { eq } from "../../src/store/expression.ts";
import { json } from "../../src/store/json-column.ts";
import { LiveQuery, QueryRefresh } from "../../src/store/live-query.ts";
import { query } from "../../src/store/query.ts";
import type { Step } from "../../src/store/step.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	flushed,
	framesOf,
	instancesOf,
	loaded,
	memoryStore,
	metered,
	rejection,
} from "../support.ts";

const Items = defineTable("items", {
	version: 1,
	columns: { id: int(), text: str(), meta: opt(json(obj({}), { version: 1 })) },
	key: ["id"],
});
const Other = defineTable("other", { version: 1, columns: { id: int() }, key: ["id"] });

/** The newest items first. */
const NEWEST = query(Items).orderBy((item) => item.id, "desc");

const Item = obj({ id: int(), text: str(), meta: opt(obj({})) });

const Board = local("app.board", {
	version: 1,
	params: {},
	members: {
		items: arr(Item),
		put: method(obj({ id: int(), text: str(), meta: opt(obj({})) })),
		rename: method(obj({ id: int(), text: str() })),
		drop: method(int()),
		other: method(int()),
	},
});

/** Live queries collected weakly as they run at activation (GC tests). */
const queries = instancesOf(LiveQuery, "load");

/** Serves `Board` with a live query of the newest `limit` items; `declare` runs first in its factory. */
function serveBoard(h: FacetHost, limit: number, declare: (self: StoreSelf) => void = () => {}): void {
	h.serve(Board, (_, self) => {
		declare(self);
		const items = self.table(Items);
		const other = self.table(Other);
		return {
			items: self.query(items, NEWEST, limit),
			put: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(items, row), ctx);
				return null;
			},
			rename: async ({ id, text }, ctx) => {
				await self.tx(async (tx) => tx.updateWhere(items, (item) => eq(item.id, id), { text }), ctx);
				return null;
			},
			drop: async (id, ctx) => {
				await self.tx(async (tx) => tx.deleteWhere(items, (item) => eq(item.id, id)), ctx);
				return null;
			},
			other: async (id, ctx) => {
				await self.tx(async (tx) => tx.put(other, { id }), ctx);
				return null;
			},
		};
	});
}

/** A host serving `Board` on `store`, metered, and a reference to the board. */
async function board(store: ChordStore, limit = 3) {
	const meter = await metered();
	// The board lives as long as its host: it activates during `load`, under the load's context.
	const { host, errors } = await loaded((h) => serveBoard(h, limit), {
		store,
		telemetry: meter.telemetry,
		context: meter.context,
	});
	const reference = await host.get(Board, {}, meter.context);
	return { ...meter, host, errors, board: reference };
}

/** The ids of `rows`. */
function ids(rows: readonly { readonly id: number }[]): number[] {
	return rows.map(({ id }) => id);
}

describe("activation", () => {
	it("runs the query before the object goes live, over the rows already stored", async () => {
		const store = await memoryStore();
		const first = await board(store);
		for (const id of [1, 2]) await first.board.put({ id, text: `t${id}` }, context);
		await first.host.close(context);
		const { board: again, host, counts } = await board(store);
		expect(again.items.value).toEqual([
			{ id: 2, text: "t2" },
			{ id: 1, text: "t1" },
		]);
		expect(counts()["chord.query.runs"]).toBe(1);
		await host.close(context);
		await store.close(context);
	});

	it("a run that fails at activation fails the activation broken", async () => {
		const store = await memoryStore();
		const first = await board(store);
		await first.board.put({ id: 1, text: "t1", meta: {} }, context);
		await first.host.close(context);
		await store.read((executor) => executor.run(`UPDATE "app.board:items" SET "meta$v" = 9`), context);
		const errors: HostError[] = [];
		const host = createHost({ store, onError: (error) => errors.push(error) });
		await host.load([{ name: "@test/app", facet: defineFacet((h) => serveBoard(h, 3)) }], context);
		const refused = (await rejection(host.get(Board, {}, context))) as ChordError;
		expect(refused.message).toContain("stored at version 9");
		expect(errors.map((error) => [error.kind, "failure" in error ? error.failure.kind : ""])).toEqual([
			["activation_failed", "broken"],
		]);
		await host.close(context);
		await store.close(context);
	});
});

describe("publication", () => {
	it("an insert, an update and a delete reach a watch as ops, in the commit's batch", async () => {
		const store = await memoryStore();
		const { board: b, host } = await board(store);
		const watch = await b.items.watch(context);
		const frames = framesOf(watch);
		await b.put({ id: 1, text: "a" }, context);
		// Published in the commit's batch: the value is current once the call returned.
		expect(ids(b.items.value)).toEqual([1]);
		await b.put({ id: 2, text: "b" }, context);
		await b.rename({ id: 1, text: "A" }, context);
		await b.drop(2, context);
		await delivered();
		// Splices of the rows at the root (`["p", path, at, deleted, inserted]`) and a set inside one row.
		expect(frames.map(([, ops]) => ops)).toEqual([
			[["p", [], 0, 0, [{ id: 1, text: "a" }]]],
			[["p", [], 0, 0, [{ id: 2, text: "b" }]]],
			[["s", [1, "text"], "A"]],
			[["p", [], 0, 1, []]],
		]);
		expect(b.items.value).toEqual([{ id: 1, text: "A" }]);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});

	it("keeps the window at its limit: a newer row pushes the oldest out", async () => {
		const store = await memoryStore();
		const { board: b, host } = await board(store, 2);
		for (const id of [1, 2]) await b.put({ id, text: `t${id}` }, context);
		const watch = await b.items.watch(context);
		const frames = framesOf(watch);
		await b.put({ id: 3, text: "t3" }, context);
		await delivered();
		expect(ids(b.items.value)).toEqual([3, 2]);
		expect(frames.map(([, ops]) => ops)).toEqual([
			[
				["p", [], 0, 0, [{ id: 3, text: "t3" }]],
				["p", [], 2, 1, []],
			],
		]);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});

	it("keeps an unchanged row the same object across runs, a changed one new", async () => {
		const store = await memoryStore();
		const { board: b, host } = await board(store);
		for (const id of [1, 2]) await b.put({ id, text: `t${id}`, meta: {} }, context);
		const [two, one] = b.items.value;
		await b.rename({ id: 2, text: "T2" }, context);
		const [twoAfter, oneAfter] = b.items.value;
		expect([oneAfter === one, twoAfter === two]).toEqual([true, false]);
		expect(twoAfter).toEqual({ id: 2, text: "T2", meta: {} });
		await host.close(context);
		await store.close(context);
	});

	it("a commit writing another table runs no query and publishes nothing (cost guard)", async () => {
		const store = await memoryStore();
		const { board: b, host, context: counting, counts } = await board(store);
		const watch = await b.items.watch(context);
		const calls = changesOf(watch);
		const statements = (): number => counts()["chord.store.statements"] ?? 0;
		const runs = (): number => counts()["chord.query.runs"] ?? 0;
		let before = [statements(), runs()];
		await b.other(1, counting);
		const other = [statements() - before[0]!, runs() - before[1]!];
		before = [statements(), runs()];
		await b.put({ id: 1, text: "a" }, counting);
		const touching = [statements() - before[0]!, runs() - before[1]!];
		await delivered();
		// The same one-row put: the touching commit costs one query, one statement more.
		expect(other[1]).toBe(0);
		expect(touching).toEqual([other[0]! + 1, 1]);
		expect(calls).toHaveLength(1);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});
});

describe("reload", () => {
	it("restarts the object: the new attempt's query runs at its activation and takes over", async () => {
		const store = await memoryStore();
		const { board: b, host, context: counting, counts } = await board(store);
		for (const id of [1, 2, 3]) await b.put({ id, text: `t${id}` }, context);
		const report = await host.reload([{ name: "@test/app", facet: defineFacet((h) => serveBoard(h, 2)) }], context);
		expect(report.objects).toEqual([{ object: "app.board", kind: "restarted" }]);
		await flushed();
		expect(ids(b.items.value)).toEqual([3, 2]);
		const runs = counts()["chord.query.runs"] ?? 0;
		await b.put({ id: 4, text: "t4" }, counting);
		expect(ids(b.items.value)).toEqual([4, 3]);
		// Only the new attempt's query runs: the old one left with its attempt.
		expect((counts()["chord.query.runs"] ?? 0) - runs).toBe(1);
		await host.close(context);
		await store.close(context);
	});
});

describe("declaration", () => {
	const refusals: [string, (self: StoreSelf) => void, string][] = [
		["no limit", (self) => void self.query(self.table(Items), NEWEST, undefined as never), "a limit is required"],
		["a limit of 0", (self) => void self.query(self.table(Items), NEWEST, 0), "a limit is required"],
		["a fractional limit", (self) => void self.query(self.table(Items), NEWEST, 2.5), "a limit is required"],
		[
			"a query of another table",
			(self) => void self.query(self.table(Other), NEWEST as never, 3),
			'a query of table "items" over "other"',
		],
		[
			"a table this factory did not declare",
			(self) => void self.query({} as never, NEWEST, 3),
			"the table is not one this factory declared",
		],
	];

	for (const [what, declare, message] of refusals) {
		it(`refuses ${what}`, async () => {
			const store = await memoryStore();
			const { host } = await loaded(
				(h) =>
					h.serve(Board, (_, self) => {
						declare(self);
						throw new Error("unreachable");
					}),
				{ store },
			);
			const refused = (await rejection(host.get(Board, {}, context))) as ChordError;
			expect(refused.message).toContain(message);
			await host.close(context);
			await store.close(context);
		});
	}

	it("staging refuses a query without a valid limit: the plugin keeps its old code", async () => {
		const store = await memoryStore();
		const { board: b, host } = await board(store);
		const report = await host.reload([{ name: "@test/app", facet: defineFacet((h) => serveBoard(h, 0)) }], context);
		expect(report.failed.map(({ error }) => (error as Error).message)).toEqual([
			expect.stringContaining("a limit is required"),
		]);
		expect(b.state.value).toEqual({ kind: "live" });
		await host.close(context);
		await store.close(context);
	});
});

describe("failure", () => {
	it("a failing run is a failed member, reported once; the next good run heals it", async () => {
		const store = await memoryStore();
		const { board: b, host, errors } = await board(store);
		await b.put({ id: 1, text: "a", meta: {} }, context);
		const watch = await b.items.watch(context);
		const calls = changesOf(watch);
		await store.read((executor) => executor.run(`UPDATE "app.board:items" SET "meta$v" = 9`), context);
		await b.put({ id: 2, text: "b" }, context);
		await b.put({ id: 3, text: "c" }, context);
		expect(() => b.items.value).toThrow("stored at version 9");
		await b.drop(1, context);
		await delivered();
		expect(calls.map((call) => call.kind)).toEqual(["failed", "value"]);
		expect(calls[1]).toMatchObject({
			ops: [
				[
					"r",
					[
						{ id: 3, text: "c" },
						{ id: 2, text: "b" },
					],
				],
			],
		});
		expect(errors.map((error) => [error.kind, "table" in error ? error.table : ""])).toEqual([
			["query_failed", "items"],
		]);
		// The object stays live: only the member failed.
		expect(b.state.value).toEqual({ kind: "live" });
		watch.stop();
		await host.close(context);
		await store.close(context);
	});
});

describe("memory", () => {
	it("collects a restarted attempt's query: no commit re-runs it", async () => {
		const store = await memoryStore();
		const { host } = await board(store);
		const from = queries.length - 1;
		await host.reload([{ name: "@test/app", facet: defineFacet((h) => serveBoard(h, 2)) }], context);
		await flushed();
		await expectCollected(queries[from]!);
		await host.close(context);
		await store.close(context);
	});
});

describe("a refresh applied again", () => {
	it("adopts its last application's runs only: a grouped commit that rolled back applies again alone", async () => {
		const adopted: unknown[] = [];
		let runs = 0;
		// Stubs: the refresh only calls a query's rerun and adopt, and hands the step through.
		const stub = {
			rerun: async () => ({ kind: "rows", rows: ++runs }),
			adopt: (run: unknown) => void adopted.push(run),
		} as unknown as LiveQuery;
		const refresh = new QueryRefresh([stub], context);
		await refresh.write.apply({} as Step);
		await refresh.write.apply({} as Step);
		refresh.adopt();
		expect(adopted).toEqual([{ kind: "rows", rows: 2 }]);
	});
});
