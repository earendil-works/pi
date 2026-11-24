// Readers of named queries (slice 14 §3.1, §3.2, test list 1 to 4, 10, 13b): `self.liveQuery` and `self.count` read
// another object's named query through its reference, or the owner's own; the first run comes before the reader is
// live; a commit of the store's owner publishes the diff in its batch; arguments may follow a value; a reader whose
// read cannot run parks and heals; refused arguments break it; the mapping gets only the declared columns.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, bool, int, local, method, obj, queries, str } from "../../src/contracts/index.ts";
import type { ChordError } from "../../src/data/index.ts";
import { createHost, defineFacet, type FacetHost, type HostError, type StoreSelf } from "../../src/host/index.ts";
import { defineColumns } from "../../src/store/column-set.ts";
import { eq, exists } from "../../src/store/expression.ts";
import { LiveQuery } from "../../src/store/live-query.ts";
import { query } from "../../src/store/query.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	flushed,
	holdNextCommit,
	instancesOf,
	memoryStore,
	metered,
	rejection,
} from "../support.ts";

const Notes = defineTable("notes", {
	version: 1,
	columns: { id: int(), board: str(), text: str(), stars: int({ default: 0 }), hidden: bool({ default: false }) },
	key: ["id"],
	indexes: { by_board: ["board", "id"] },
});
const Note = obj({ id: int(), text: str() });

const NoteStore = local("app.notes", {
	version: 1,
	params: {},
	members: {
		notes: queries(Note, { ofBoard: obj({ board: str() }), one: obj({ id: int() }) }),
		put: method(obj({ id: int(), board: str(), text: str() })),
		star: method(int()),
		rename: method(obj({ id: int(), text: str() })),
		drop: method(int()),
	},
});

const Board = local("app.board", {
	version: 1,
	params: { board: str() },
	members: {
		notes: obj({ rows: arr(Note), more: bool() }),
		count: int(),
	},
});

/** How often the store's mapping ran, and with which columns. */
type Probe = { mapped: string[][] };

function serveStore(h: FacetHost, probe: Probe = { mapped: [] }, declare: (self: StoreSelf) => void = () => {}): void {
	h.serve(NoteStore, (_, self) => {
		declare(self);
		const table = self.table(Notes);
		const notes = self.queries(
			table,
			{
				map: (row) => {
					probe.mapped.push(Object.keys(row).sort());
					return { id: row.id, text: row.text };
				},
				reads: ["id", "text"],
			},
			{
				ofBoard: ({ board }: { board: string }) => {
					if (board === "broken") throw new Error("no such board");
					return query(Notes)
						.where((n) => eq(n.board, board))
						.orderBy((n) => n.id, "desc");
				},
				one: ({ id }: { id: number }) => query(Notes).where((n) => eq(n.id, id)),
			},
		);
		return {
			notes,
			put: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(table, row), ctx);
				return null;
			},
			star: async (id, ctx) => {
				await self.tx(async (tx) => tx.update(table, { id }, { stars: 5 }), ctx);
				return null;
			},
			rename: async ({ id, text }, ctx) => {
				await self.tx(async (tx) => tx.update(table, { id }, { text }), ctx);
				return null;
			},
			drop: async (id, ctx) => {
				await self.tx(async (tx) => tx.delete(table, { id }), ctx);
				return null;
			},
		};
	});
}

function serveBoard(h: FacetHost, first = 2): void {
	h.serve(Board, ({ board }, self) => {
		const store = self.get(NoteStore, {});
		return {
			notes: self.liveQuery(store.notes.ofBoard, { board }, { first }),
			count: self.count(store.notes.ofBoard, { board }),
		};
	});
}

/** A host on `store` with the note store and boards served by two plugins, metered. */
async function hosted(store: ChordStore, probe?: Probe) {
	const meter = await metered();
	const errors: HostError[] = [];
	const host = createHost({ store, telemetry: meter.telemetry, onError: (error) => errors.push(error) });
	await host.load(
		[
			{ name: "@test/store", facet: defineFacet((h) => serveStore(h, probe)) },
			{ name: "@test/boards", facet: defineFacet((h) => serveBoard(h)) },
		],
		meter.context,
	);
	const notes = await host.get(NoteStore, {}, meter.context);
	return { ...meter, host, errors, notes };
}

describe("open", () => {
	it("reads another object's named query before the reader is live, and counts it", async () => {
		const store = await memoryStore();
		const first = await hosted(store);
		for (const id of [1, 2, 3]) await first.notes.put({ id, board: "a", text: `t${id}` }, context);
		await first.notes.put({ id: 9, board: "b", text: "other" }, context);
		const board = await first.host.get(Board, { board: "a" }, context);
		expect(board.notes.value).toEqual({
			rows: [
				{ id: 3, text: "t3" },
				{ id: 2, text: "t2" },
			],
			more: true,
		});
		expect(board.count.value).toBe(3);
		await first.host.close(context);
		await store.close(context);
	});

	it("publishes a commit's change in its batch as a diff; a commit that cannot change it runs nothing", async () => {
		const store = await memoryStore();
		const { host, notes, counts, context: counting } = await hosted(store);
		await notes.put({ id: 1, board: "a", text: "t1" }, context);
		const board = await host.get(Board, { board: "a" }, context);
		const watch = await board.notes.watch(context);
		const calls = changesOf(watch);
		const runs = (): number => counts()["chord.query.runs"] ?? 0;
		let before = runs();
		// Another board's note: the list's probe misses; the count keeps no keys and runs.
		await notes.put({ id: 7, board: "b", text: "x" }, counting);
		await delivered();
		expect(calls).toHaveLength(0);
		expect(runs() - before).toBe(1);
		before = runs();
		// A column neither read depends on: nothing runs.
		await notes.star(1, counting);
		expect(runs() - before).toBe(0);
		await notes.put({ id: 2, board: "a", text: "t2" }, counting);
		await delivered();
		expect(board.notes.value).toEqual({
			rows: [
				{ id: 2, text: "t2" },
				{ id: 1, text: "t1" },
			],
			more: false,
		});
		expect(board.count.value).toBe(2);
		expect(calls).toHaveLength(1);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});
});

describe("the commit step chooses its reads", () => {
	it("a read opened while a commit waits in the queue is refreshed by it", async () => {
		const store = await memoryStore();
		const { host, notes } = await hosted(store);
		// One commit held in its step, the note's commit queued behind it: staged before the reader exists.
		const held = holdNextCommit(store);
		const blocking = notes.put({ id: 50, board: "z", text: "blocker" }, context);
		await held.entered;
		const queued = notes.put({ id: 1, board: "a", text: "late" }, context);
		// The reader registers its reads now; their first runs wait behind the held transaction.
		const getting = host.get(Board, { board: "a" }, context);
		await flushed();
		held.release();
		await Promise.all([blocking.catch(() => {}), queued]);
		const board = await getting;
		expect(board.notes.value.rows).toEqual([{ id: 1, text: "late" }]);
		expect(board.count.value).toBe(1);
		await host.close(context);
		await store.close(context);
	});
});

describe("projection", () => {
	it("hands the mapping only the declared columns; an unlisted column's update changes no item", async () => {
		const store = await memoryStore();
		const probe: Probe = { mapped: [] };
		const { host, notes } = await hosted(store, probe);
		await notes.put({ id: 1, board: "a", text: "t1" }, context);
		const board = await host.get(Board, { board: "a" }, context);
		const item = board.notes.value.rows[0];
		expect(probe.mapped.at(-1)).toEqual(["id", "text"]);
		const mapped = probe.mapped.length;
		await notes.star(1, context);
		expect(probe.mapped).toHaveLength(mapped);
		expect(board.notes.value.rows[0]).toBe(item);
		await notes.rename({ id: 1, text: "renamed" }, context);
		expect(board.notes.value.rows).toEqual([{ id: 1, text: "renamed" }]);
		await host.close(context);
		await store.close(context);
	});
});

const Filter = local("app.filter", { version: 1, params: {}, members: { board: str(), show: method(str()) } });
const Filtered = local("app.filtered", {
	version: 1,
	params: {},
	members: { notes: obj({ rows: arr(Note), more: bool() }) },
});

/** A filter whose `board` a method sets, and a view whose arguments follow it. */
function serveFiltered(h: FacetHost, factories: string[] = []): void {
	h.serve(Filter, (_, self) => {
		const board = self.writable("a");
		return {
			board: self.derive([board], ([value]) => value),
			show: async (value) => {
				board.set(value);
				return null;
			},
		};
	});
	h.serve(Filtered, (_, self) => {
		factories.push("filtered");
		const filter = self.get(Filter, {});
		const args = self.derive([filter.board], ([board]) => ({ board }));
		return { notes: self.liveQuery(self.get(NoteStore, {}).notes.ofBoard, args, { first: 5 }) };
	});
}

describe("arguments that follow a value", () => {
	it("shows the old rows until the read for the new arguments ran, then switches in one frame", async () => {
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const facets = [
			{ name: "@test/store", facet: defineFacet((h) => serveStore(h)) },
			{ name: "@test/views", facet: defineFacet((h) => serveFiltered(h)) },
		];
		await host.load(facets, context);
		const notes = await host.get(NoteStore, {}, context);
		await notes.put({ id: 1, board: "a", text: "a1" }, context);
		await notes.put({ id: 2, board: "b", text: "b2" }, context);
		const view = await host.get(Filtered, {}, context);
		const filter = await host.get(Filter, {}, context);
		expect(view.notes.value.rows).toEqual([{ id: 1, text: "a1" }]);
		const watch = await view.notes.watch(context);
		const calls = changesOf(watch);
		await filter.show("b", context);
		await flushed();
		await delivered();
		// One frame, from the rows of "a" straight to the rows of "b": never an empty list in between.
		expect(view.notes.value.rows).toEqual([{ id: 2, text: "b2" }]);
		expect(calls.map((call) => (call.kind === "value" ? call.value.rows : call.kind))).toEqual([
			[{ id: 2, text: "b2" }],
		]);
		// The read of board "a" is gone: a note there changes nothing here.
		await notes.put({ id: 3, board: "a", text: "a3" }, context);
		await notes.put({ id: 4, board: "b", text: "b4" }, context);
		expect(view.notes.value.rows.map((row) => row.id)).toEqual([4, 2]);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});
});

describe("arguments the builder refuses", () => {
	it("fail the member; a write to the previous arguments' rows neither heals it nor publishes them", async () => {
		// Review round 1 (Sol 4).
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const facets = [
			{ name: "@test/store", facet: defineFacet((h) => serveStore(h)) },
			{ name: "@test/views", facet: defineFacet((h) => serveFiltered(h)) },
		];
		await host.load(facets, context);
		const notes = await host.get(NoteStore, {}, context);
		await notes.put({ id: 1, board: "a", text: "first" }, context);
		const view = await host.get(Filtered, {}, context);
		const filter = await host.get(Filter, {}, context);
		const watch = await view.notes.watch(context);
		const calls = changesOf(watch);
		await filter.show("broken", context);
		await flushed();
		expect(() => view.notes.value).toThrow("no such board");
		await notes.put({ id: 1, board: "a", text: "edited" }, context);
		await delivered();
		expect(() => view.notes.value).toThrow("no such board");
		expect(calls.map((call) => call.kind)).toEqual(["failed"]);
		// Arguments that build again read again: the member heals with their rows.
		await filter.show("a", context);
		await flushed();
		expect(view.notes.value.rows).toEqual([{ id: 1, text: "edited" }]);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});
});

describe("failures", () => {
	it("arguments the contract's schema refuses break the reader", async () => {
		const store = await memoryStore();
		const errors: HostError[] = [];
		const host = createHost({ store, onError: (error) => errors.push(error) });
		const Broken = local("app.broken", {
			version: 1,
			params: {},
			members: { notes: obj({ rows: arr(Note), more: bool() }) },
		});
		const facets = [
			{ name: "@test/store", facet: defineFacet((h) => serveStore(h)) },
			{
				name: "@test/views",
				facet: defineFacet((h) => {
					h.serve(Broken, (_, self) => ({
						// Plugin code is bundled without type checks: a wrong argument reaches the schema.
						notes: self.liveQuery(
							self.get(NoteStore, {}).notes.one,
							{ id: "x" as unknown as number },
							{ first: 1 },
						),
					}));
				}),
			},
		];
		await host.load(facets, context);
		const refused = (await rejection(host.get(Broken, {}, context))) as ChordError;
		expect(refused).toMatchObject({ code: "invalid", reason: "args" });
		expect(
			errors.map((error) => [
				error.kind,
				error.kind === "activation_failed" || error.kind === "object_failed" ? error.failure.kind : "",
			]),
		).toEqual([["activation_failed", "broken"]]);
		await host.close(context);
		await store.close(context);
	});

	it("the wrong form of each call throws naming the other; a private query needs its schema", async () => {
		const store = await memoryStore();
		const thrown: string[] = [];
		const attempt = (work: () => unknown): void => {
			try {
				work();
			} catch (error) {
				thrown.push((error as Error).message);
			}
		};
		const host = createHost({ store, onError: () => {} });
		const Own = local("app.own", { version: 1, params: {}, members: { n: int() } });
		const facet = defineFacet((h) => {
			h.serve(Own, (_, self) => {
				const table = self.table(Notes);
				const named = self.queries(
					table,
					{ map: (row) => row.id },
					{ all: [obj({}), (_args: Record<string, never>) => query(Notes)] },
				);
				// Plugin code is bundled without type checks: each form is handed the other's argument.
				attempt(() => self.query(named.all as never, query(Notes), 3));
				attempt(() => self.liveQuery(table as never, {}, { first: 1 }));
				attempt(() => self.liveQuery(named.all, {}, {} as never));
				return { n: self.count(named.all, {}) };
			});
		});
		await host.load([{ name: "@test/own", facet }], context);
		expect(thrown).toEqual([
			"app.own: self.query reads a table of this object; a named query is read with self.liveQuery",
			"app.own: self.liveQuery reads a named query; a table of this object is read with self.query",
			"app.own: self.liveQuery: { first: n } is required, a positive integer",
		]);
		// The owner's own private query, counted: read in its own activation, no dependency on itself.
		const own = await host.get(Own, {}, context);
		expect(own.n.value).toBe(0);
		await host.close(context);
		await store.close(context);
	});
});

const TagSet = defineColumns("tags.columns", { columns: { note: int(), tag: str() }, key: ["note", "tag"] });
const Tags = defineTable("tags", { version: 1, columns: { ...TagSet.columns }, key: ["note", "tag"], exposes: TagSet });
const TagStore = local("app.tags", {
	version: 1,
	params: {},
	members: { tag: method(obj({ note: int(), tag: str() })) },
});
const Tagged = local("app.tagged", {
	version: 1,
	params: {},
	members: { notes: obj({ rows: arr(Note), more: bool() }) },
});

function serveTags(h: FacetHost): void {
	h.serve(TagStore, (_, self) => {
		const table = self.table(Tags);
		return {
			tag: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(table, row), ctx);
				return null;
			},
		};
	});
}

const TaggedNotes = local("app.tagged-notes", {
	version: 1,
	params: {},
	members: {
		notes: queries(Note, { tagged: obj({ tag: str() }) }),
		put: method(obj({ id: int(), board: str(), text: str() })),
	},
});
const Mine = defineTable("mine", { version: 1, columns: { id: int(), board: str(), text: str() }, key: ["id"] });

/** A store whose query tests `exists` in the tags' column set (another plugin's), and a view of it. */
function serveTagged(h: FacetHost): void {
	h.serve(TaggedNotes, (_, self) => {
		const table = self.table(Mine);
		return {
			notes: self.queries(
				table,
				{ map: (row) => ({ id: row.id, text: row.text }) },
				{
					tagged: ({ tag }: { tag: string }) =>
						query(Mine).where((n) => exists(TagSet, { note: n.id }, (t) => eq(t.tag, tag))),
				},
			),
			put: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(table, row), ctx);
				return null;
			},
		};
	});
	h.serve(Tagged, (_, self) => ({
		notes: self.liveQuery(self.get(TaggedNotes, {}).notes.tagged, { tag: "red" }, { first: 5 }),
	}));
}

describe("a column set nobody serves", () => {
	it("parks the reader failed { waiting } and heals when the set is served; the other owner's commit then reaches it", async () => {
		const store = await memoryStore();
		const errors: HostError[] = [];
		const host = createHost({ store, onError: (error) => errors.push(error) });
		const tagged = { name: "@test/tagged", facet: defineFacet((h) => serveTagged(h)) };
		await host.load([tagged], context);
		const notes = await host.get(TaggedNotes, {}, context);
		await notes.put({ id: 1, board: "a", text: "t1" }, context);
		const view = host.hold(Tagged, {}, context);
		await flushed();
		expect(view.state.value).toMatchObject({
			kind: "failed",
			cause: {
				kind: "waiting",
				error: { code: "unavailable", message: expect.stringContaining('"tags.columns" is not served') },
			},
		});
		await host.reload([tagged, { name: "@test/tags", facet: defineFacet((h) => serveTags(h)) }], context);
		// The tags' store goes live when someone holds it: its table then exposes the set, and the reader runs.
		const tags = await host.get(TagStore, {}, context);
		await flushed();
		expect(view.state.value).toEqual({ kind: "live" });
		expect(view.notes.value.rows).toEqual([]);
		// The tags' owner commits: the read over its table runs in that owner's step.
		await tags.tag({ note: 1, tag: "red" }, context);
		expect(view.notes.value.rows).toEqual([{ id: 1, text: "t1" }]);
		await tags.tag({ note: 1, tag: "blue" }, context);
		expect(view.notes.value.rows).toEqual([{ id: 1, text: "t1" }]);
		// A closing host reports no read failed: its objects keep their sets bound until every object is torn down
		// (the readers' reads are closed by then), and leave none in the store.
		errors.length = 0;
		await host.close(context);
		expect(errors).toEqual([]);
		expect(store.reads.get(TagSet.name)).toBeUndefined();
		view.release();
		await store.close(context);
	});
});

describe("readers before natives (code review round 1)", () => {
	it("an attempt that waits on its reader holds no native: it opens when the read ran", async () => {
		// Opus S3, Fable S9: a waiting attempt keeps nothing open that a native holds (a socket, a process).
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const natives: string[] = [];
		const Watching = local("app.watching", {
			version: 1,
			params: {},
			members: { notes: obj({ rows: arr(Note), more: bool() }) },
		});
		const tagged = { name: "@test/tagged", facet: defineFacet((h) => serveTagged(h)) };
		const watching = {
			name: "@test/watching",
			facet: defineFacet((h) => {
				h.serve(Watching, (_, self) => {
					self.open(
						async () => natives.push("open"),
						() => {
							natives.push("close");
						},
					);
					return { notes: self.liveQuery(self.get(TaggedNotes, {}).notes.tagged, { tag: "red" }, { first: 5 }) };
				});
			}),
		};
		await host.load([tagged, watching], context);
		const view = host.hold(Watching, {}, context);
		await flushed();
		expect(view.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect(natives).toEqual([]);
		await host.reload([tagged, watching, { name: "@test/tags", facet: defineFacet((h) => serveTags(h)) }], context);
		await host.get(TagStore, {}, context);
		await flushed();
		expect(view.state.value).toEqual({ kind: "live" });
		expect(natives).toEqual(["open"]);
		view.release();
		await host.close(context);
		await store.close(context);
	});
});

describe("arguments that have no value when the reader opens (code review round 2)", () => {
	it("break the attempt, naming the rule: a followed source attaches after the readers, so waiting would never end", async () => {
		// Opus S1: the argument's derive threw `not_ready`, the reader waited, and nothing could wake the attempt.
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const Following = local("app.following", {
			version: 1,
			params: {},
			members: { notes: obj({ rows: arr(Note), more: bool() }) },
		});
		const facet = defineFacet((h) => {
			serveStore(h);
			h.serve(Following, (_, self) => {
				const board = self.follow<{ board: string }>(async () => ({ value: { board: "a" }, detach: () => {} }));
				const args = self.derive([board], ([followed]) => ({ board: followed.board }));
				return { notes: self.liveQuery(self.get(NoteStore, {}).notes.ofBoard, args, { first: 5 }) };
			});
		});
		await host.load([{ name: "@test/following", facet }], context);
		const view = host.hold(Following, {}, context);
		await flushed();
		expect(view.state.value).toMatchObject({
			kind: "failed",
			cause: {
				kind: "broken",
				error: {
					code: "invalid",
					message: expect.stringContaining(
						"a reader's arguments read references, registries, writables and earlier reads, not a followed source or a native",
					),
				},
			},
		});
		view.release();
		await host.close(context);
		await store.close(context);
	});
});

describe("a provider's restart", () => {
	it("does not restart its readers: they read the successor's query and give one frame, none when equal", async () => {
		const store = await memoryStore();
		const factories: string[] = [];
		const host = createHost({ store, onError: () => {} });
		const storeFacet = { name: "@test/store", facet: defineFacet((h) => serveStore(h)) };
		const views = { name: "@test/views", facet: defineFacet((h) => serveFiltered(h, factories)) };
		await host.load([storeFacet, views], context);
		const notes = await host.get(NoteStore, {}, context);
		for (const id of [1, 2]) await notes.put({ id, board: "a", text: `t${id}` }, context);
		const view = await host.get(Filtered, {}, context);
		const watch = await view.notes.watch(context);
		const calls = changesOf(watch);
		expect(factories).toEqual(["filtered"]);
		// The same code again: the readers bind to the successor, and equal rows send nothing.
		await host.reload([{ name: "@test/store", facet: defineFacet((h) => serveStore(h)) }, views], context);
		await flushed();
		await delivered();
		expect(factories).toEqual(["filtered"]);
		expect(calls).toHaveLength(0);
		// The successor's commit reaches the reader, once.
		await notes.put({ id: 3, board: "a", text: "t3" }, context);
		await delivered();
		expect(view.notes.value.rows.map((row) => row.id)).toEqual([3, 2, 1]);
		expect(calls).toHaveLength(1);
		watch.stop();
		await host.close(context);
		await store.close(context);
	});
});

describe("count", () => {
	it("is exact and uncapped; skipped only by an update of no condition column", async () => {
		const store = await memoryStore();
		const { host, notes, counts, context: counting } = await hosted(store);
		for (let id = 1; id <= 300; id++) await notes.put({ id, board: "a", text: "t" }, context);
		const board = await host.get(Board, { board: "a" }, context);
		expect(board.count.value).toBe(300);
		const runs = (): number => counts()["chord.query.runs"] ?? 0;
		const before = runs();
		// A rename: the list's mapped column (one run), no condition column of the count.
		await notes.rename({ id: 300, text: "renamed" }, counting);
		expect(runs() - before).toBe(1);
		await notes.drop(300, counting);
		expect(board.count.value).toBe(299);
		await host.close(context);
		await store.close(context);
	});
});

describe("memory", () => {
	it("collects a reader's live query once its object ended", async () => {
		const live = instancesOf(LiveQuery, "read");
		const store = await memoryStore();
		const { host } = await hosted(store);
		const board = await host.get(Board, { board: "a" }, context);
		expect(board.count.value).toBe(0);
		const mine = live.slice(-2);
		board.release();
		await host.close(context);
		await store.close(context);
		await expectCollected(...mine);
	});
});
