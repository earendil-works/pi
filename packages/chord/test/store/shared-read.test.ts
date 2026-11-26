// Tests of shared live reads (`src/store/shared-read.ts`; decision "Identical live reads share one source"): readers of
// the same provider instance's named query with the same arguments and shape share one read: one entry in the store's
// index, one run, one decode and one value per write. Arguments that change move a reader between reads, the
// provider's restart moves every reader to one read of its successor, a shared run is counted once, a failure reaches
// every reader once, and a read goes once its last reader did, keeping nothing of its first run or of the reader that
// made it, and failing no store with a run still underway. Round 1's reproductions (Opus, Astra, Fable) are here.
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, bool, bytes, int, local, method, obj, queries, str, union, unknown } from "../../src/contracts/index.ts";
import { Attempt } from "../../src/host/attempt.ts";
import { createHost, defineFacet, type FacetHost, type Host } from "../../src/host/index.ts";
import { OwnQuery } from "../../src/host/named-query.ts";
import { eq } from "../../src/store/expression.ts";
import { query } from "../../src/store/query.ts";
import { Read } from "../../src/store/read.ts";
import { SharedRead } from "../../src/store/shared-read.ts";
import { defineTable } from "../../src/store/table.ts";
import { changesOf, delivered, expectCollected, flushed, instancesOf, memoryStore, metered } from "../support.ts";

const Notes = defineTable("notes", {
	version: 1,
	columns: { id: int(), board: str(), text: str() },
	key: ["id"],
	indexes: { by_board: ["board", "id"] },
});

const Note = obj({ id: int(), text: str() });

const NoteStore = local("app.notes", {
	version: 1,
	params: {},
	members: {
		notes: queries(Note, { ofBoard: obj({ board: str() }) }),
		put: method(obj({ id: int(), board: str(), text: str() })),
	},
});

/** A caller's own reader: the board it shows (which `show` changes), its first `first` notes and their count. */
const Reader = local("app.reader", {
	version: 1,
	params: { caller: str(), board: str(), first: int() },
	members: { notes: obj({ rows: arr(Note), more: bool() }), count: int(), show: method(str()) },
});

/** The SQL name of the notes table: where its reads are in the store's index. */
const TABLE = "app.notes:notes";

/** Every shared read made in this file, weakly. */
const shared = instancesOf(SharedRead, "subscribe");

/** How often a store's mapping ran: once per row a run decodes, whoever reads it. */
const mapped = { count: 0 };

function serveStore(h: FacetHost, label = "t"): void {
	h.serve(NoteStore, (_, self) => {
		const table = self.table(Notes);
		return {
			notes: self.queries(
				table,
				{
					map: (row) => {
						mapped.count++;
						return { id: row.id, text: `${label}:${row.text}` };
					},
					reads: ["id", "text"],
				},
				{
					ofBoard: ({ board }: { board: string }) =>
						query(Notes)
							.where((n) => eq(n.board, board))
							.orderBy((n) => n.id, "desc"),
				},
			),
			put: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(table, row), ctx);
				return null;
			},
		};
	});
}

function serveReaders(h: FacetHost): void {
	h.serve(Reader, ({ board, first }, self) => {
		const store = self.get(NoteStore, {});
		const shown = self.writable(board);
		const args = self.derive([shown], ([value]) => ({ board: value }));
		return {
			notes: self.liveQuery(store.notes.ofBoard, args, { first }),
			count: self.count(store.notes.ofBoard, args),
			show: async (value) => {
				shown.set(value);
				return null;
			},
		};
	});
}

const storePlugin = (label?: string) => ({ name: "@test/store", facet: defineFacet((h) => serveStore(h, label)) });

const readersPlugin = { name: "@test/readers", facet: defineFacet(serveReaders) };

/** A metered host with the store (notes 1 to 3 on board "a", 9 on "b") and the readers. */
async function hosted() {
	const meter = await metered();
	const store = await memoryStore();
	const host: Host = createHost({ store, telemetry: meter.telemetry, onError: () => {} });
	await host.load([storePlugin(), readersPlugin], meter.context);
	const notes = await host.get(NoteStore, {}, meter.context);
	for (const id of [1, 2, 3]) await notes.put({ id, board: "a", text: `n${id}` }, context);
	await notes.put({ id: 9, board: "b", text: "n9" }, context);
	const readers = (board: string, count: number, first = 2) =>
		Promise.all(
			Array.from({ length: count }, (_, at) => host.get(Reader, { caller: `${board}${at}`, board, first }, context)),
		);
	const runs = (): number => meter.counts()["chord.query.runs"] ?? 0;
	const rowsRead = (): number => meter.counts()["chord.query.rows"] ?? 0;
	const reads = (): number => store.reads.on(TABLE)?.size ?? 0;
	const close = async (): Promise<void> => {
		await host.close(context);
		await store.close(context);
	};
	return { host, store, notes, readers, runs, rowsRead, reads, close, metered: meter.context };
}

/** The shared reads made since `from` (an index into `shared`), each once. */
function madeSince(from: number): SharedRead[] {
	return [...new Set(shared.slice(from).map((ref) => ref.deref()!))];
}

describe("one source per query, arguments and shape", () => {
	it("readers of the same query, arguments and window share one read: one run per write, one value", async () => {
		const { notes, readers, runs, rowsRead, reads, close, metered } = await hosted();
		const from = shared.length;
		const five = await readers("a", 5);
		// One read of the window and one of the count, for all five.
		expect(madeSince(from)).toHaveLength(2);
		expect(reads()).toBe(2);
		const before = [runs(), rowsRead()];
		const decoded = mapped.count;
		// Counted in the write's context: the window's run reads its 2 rows and the one past them, once.
		await notes.put({ id: 4, board: "a", text: "n4" }, metered);
		expect([runs() - before[0]!, rowsRead() - before[1]!]).toEqual([2, 3]);
		// One decode for all five: the new row (the others are the last value's objects).
		expect(mapped.count - decoded).toBe(1);
		for (const reader of five) {
			expect(reader.notes.value).toBe(five[0]!.notes.value);
			expect(reader.count.value).toBe(4);
		}
		expect(five[0]!.notes.value).toEqual({
			rows: [
				{ id: 4, text: "t:n4" },
				{ id: 3, text: "t:n3" },
			],
			more: true,
		});
		await close();
	});

	it("a later reader takes the read's current value at once: no run, no decode", async () => {
		const { host, readers, runs, close } = await hosted();
		const [first] = await readers("a", 1);
		const before = [runs(), mapped.count];
		const later = await host.get(Reader, { caller: "later", board: "a", first: 2 }, context);
		expect([runs() - before[0]!, mapped.count - before[1]!]).toEqual([0, 0]);
		expect(later.notes.value).toBe(first!.notes.value);
		await close();
	});

	it("outlives the reader that made it: the others go on taking its runs", async () => {
		const { notes, readers, reads, close, metered } = await hosted();
		const [maker, other] = await readers("a", 2);
		maker!.release();
		await flushed();
		expect(reads()).toBe(2);
		await notes.put({ id: 4, board: "a", text: "n4" }, metered);
		expect(other!.notes.value).toMatchObject({ rows: [{ id: 4 }, { id: 3 }] });
		expect(other!.count.value).toBe(4);
		await close();
	});

	it("other arguments, another window: reads of their own", async () => {
		const { readers, reads, close } = await hosted();
		await readers("a", 2);
		await readers("b", 2);
		await readers("a", 2, 3);
		// Windows of a (2 rows), b and a (3 rows); one count of a, one of b.
		expect(reads()).toBe(5);
		await close();
	});
});

describe("arguments that change", () => {
	it("move a reader to the read of its new arguments; the read it left goes with its last reader", async () => {
		const { notes, readers, runs, reads, close, metered } = await hosted();
		const from = shared.length;
		const [a0, a1] = await readers("a", 2);
		const [b0] = await readers("b", 1);
		const [windowOfA] = madeSince(from);
		await a0!.show("b", context);
		await flushed();
		expect(a0!.notes.value).toBe(b0!.notes.value);
		expect(a1!.notes.value).toEqual({
			rows: [
				{ id: 3, text: "t:n3" },
				{ id: 2, text: "t:n2" },
			],
			more: true,
		});
		expect(windowOfA!.query.closed).toBe(false);
		await a1!.show("b", context);
		await flushed();
		expect(windowOfA!.query.closed).toBe(true);
		expect(reads()).toBe(2);
		const before = runs();
		await notes.put({ id: 10, board: "b", text: "n10" }, metered);
		expect(runs() - before).toBe(2);
		expect(a1!.notes.value).toBe(b0!.notes.value);
		await close();
	});
});

describe("the provider's restart", () => {
	it("moves every reader to one read of its successor, and closes the old one", async () => {
		const { host, readers, reads, close } = await hosted();
		const from = shared.length;
		const three = await readers("a", 3);
		const old = madeSince(from);
		const calls = await Promise.all(three.map(async (reader) => changesOf(await reader.notes.watch(context))));
		await host.reload([storePlugin("u"), readersPlugin], context);
		await flushed();
		await delivered();
		// One frame each, from the old rows to the successor's.
		for (const each of calls) expect(each).toHaveLength(1);
		for (const reader of three) expect(reader.notes.value).toBe(three[0]!.notes.value);
		expect(three[0]!.notes.value).toMatchObject({ rows: [{ id: 3, text: "u:n3" }, { id: 2 }] });
		expect(old.every((read) => read.query.closed)).toBe(true);
		expect(madeSince(from).length - old.length).toBe(2);
		expect(reads()).toBe(2);
		await close();
	});
});

describe("GC", () => {
	it("a shared read goes once its last reader ended: it leaves the store's index and is collected", async () => {
		const { readers, reads, close } = await hosted();
		const from = shared.length;
		const three = await readers("a", 3);
		const made = madeSince(from).map((read) => new WeakRef(read));
		for (const reader of three) reader.release();
		await flushed();
		expect(reads()).toBe(0);
		await expectCollected(...made);
		await close();
	});
});

/** Every attempt that declared a live query in this file, weakly. */
const attempts = instancesOf(Attempt, "liveQuery");

/**
 * Holds the first fetch run from now on after it fetched its rows, until `release`; later fetches run as they are.
 * Commit steps fetch through `Read.fetch` too.
 */
function holdFirstFetch(fail?: Error) {
	const gate = Promise.withResolvers<void>();
	const fetched = Promise.withResolvers<void>();
	const fetch = Read.prototype.fetch;
	let first = true;
	Read.prototype.fetch = async function (this: Read, ...args: Parameters<Read["fetch"]>) {
		const held = first;
		first = false;
		if (!held) return fetch.apply(this, args);
		const run = await fetch.apply(this, args);
		fetched.resolve();
		await gate.promise;
		if (fail !== undefined) throw fail;
		return run;
	};
	const release = (): void => {
		Read.prototype.fetch = fetch;
		gate.resolve();
	};
	return { fetched: fetched.promise, release };
}

describe("what a shared read keeps (round 1)", () => {
	it("not the stored rows of its first run, while it stays open (Opus M1, Astra 5b, Fable 1)", async () => {
		const { readers, close } = await hosted();
		const rows: WeakRef<object>[] = [];
		const fetch = Read.prototype.fetch;
		Read.prototype.fetch = async function (this: Read, ...args: Parameters<Read["fetch"]>) {
			const run = await fetch.apply(this, args);
			if (run.kind === "rows") rows.push(...run.result.rows.map((row) => new WeakRef(row)));
			return run;
		};
		try {
			const [reader] = await readers("a", 1);
			expect(rows.length).toBeGreaterThan(0);
			await expectCollected(...rows);
			expect(reader!.notes.value.rows).toHaveLength(2);
		} finally {
			Read.prototype.fetch = fetch;
			await close();
		}
	});

	it("not the attempt of the reader that made it, once that one ended (Opus M2, Astra 2, Fable 2)", async () => {
		const { readers, host, reads, notes, close } = await hosted();
		const from = attempts.length;
		const [maker] = await readers("a", 1);
		const made = attempts.slice(from);
		const other = await host.get(Reader, { caller: "other", board: "a", first: 2 }, context);
		maker!.release();
		await flushed();
		expect(reads()).toBe(2);
		await notes.put({ id: 4, board: "a", text: "n4" }, context);
		expect(other.notes.value.rows[0]).toMatchObject({ id: 4 });
		await expectCollected(...made);
		await close();
	});

	it("no later value through an earlier one somebody holds: the diff cache is no chain (Opus M3, Astra 3, Fable 3)", async () => {
		const { readers, notes, close } = await hosted();
		const [reader] = await readers("a", 1);
		(await reader!.notes.watch(context)).start(async () => {});
		// What app code does: it keeps a value it read (a snapshot to compare with, a closure).
		const held = reader!.notes.value;
		await notes.put({ id: 4, board: "a", text: "n4" }, context);
		const later = new WeakRef(reader!.notes.value as object);
		for (const id of [5, 6, 7, 8]) await notes.put({ id, board: "a", text: `n${id}` }, context);
		await expectCollected(later);
		expect(held.rows).toHaveLength(2);
		await close();
	});
});

describe("a run still underway (round 1)", () => {
	it("a late backend error after its last reader left fails no store (Astra 1)", async () => {
		const { notes, readers, reads, close } = await hosted();
		const [reader] = await readers("a", 1);
		const held = holdFirstFetch(new Error("backend read failed after release"));
		try {
			// The read of board "c" starts; its first run is held.
			const showing = reader!.show("c", context);
			await held.fetched;
			await showing;
			reader!.release();
			await flushed();
			expect(reads()).toBe(0);
			held.release();
			await flushed();
			// The store is not stopped: an unrelated write commits.
			await notes.put({ id: 12, board: "d", text: "n12" }, context);
		} finally {
			held.release();
			await close();
		}
	});

	it("a load a rebind overtook, failing after the last reader left, fails no store (Fable, round 2)", async () => {
		const { notes, readers, reads, close } = await hosted();
		const [reader] = await readers("a", 1);
		const from = shared.length;
		const held = holdFirstFetch(new Error("backend read failed after release"));
		try {
			// The reads of board "c" start; the first one's first run is held.
			const showing = reader!.show("c", context);
			await held.fetched;
			await showing;
			// A binding changed meanwhile (a set bound, a table ready after a migration): each read loads again.
			for (const read of madeSince(from)) read.rebound();
			await flushed();
			reader!.release();
			await flushed();
			expect(reads()).toBe(0);
			held.release();
			await flushed();
			// The store is not stopped: an unrelated write commits.
			await notes.put({ id: 12, board: "d", text: "n12" }, context);
		} finally {
			held.release();
			await close();
		}
	});

	it("readers waiting on the first run go on when a commit's run overtakes it (Astra, round 2)", async () => {
		const { host, notes, close } = await hosted();
		const held = holdFirstFetch();
		try {
			const first = host.hold(Reader, { caller: "first", board: "a", first: 2 }, context);
			await held.fetched;
			const early = host.hold(Reader, { caller: "early", board: "a", first: 2 }, context);
			await flushed();
			await notes.put({ id: 7, board: "a", text: "n7" }, context);
			const late = host.hold(Reader, { caller: "late", board: "a", first: 2 }, context);
			await flushed();
			// The first run is still held: every reader is live with the commit's run.
			for (const reader of [first, early, late]) {
				expect(reader.state.value).toEqual({ kind: "live" });
				expect(reader.notes.value.rows[0]).toMatchObject({ id: 7 });
			}
			first.release();
			early.release();
			late.release();
		} finally {
			held.release();
			await close();
		}
	});

	it("a reader joining after a newer run was adopted is live at once, whatever the first run does (Astra 5a, Opus S3)", async () => {
		const { host, notes, close } = await hosted();
		const held = holdFirstFetch();
		try {
			const first = host.hold(Reader, { caller: "first", board: "a", first: 2 }, context);
			await held.fetched;
			// A commit overtakes the first run and its run is adopted.
			await notes.put({ id: 4, board: "a", text: "n4" }, context);
			const later = host.hold(Reader, { caller: "later", board: "a", first: 2 }, context);
			await flushed();
			expect(later.state.value).toEqual({ kind: "live" });
			expect(later.notes.value.rows[0]).toMatchObject({ id: 4 });
			first.release();
			later.release();
		} finally {
			held.release();
			await close();
		}
	});

	it("the maker leaving while the first run is held: the other reader still gets it", async () => {
		const { host, close, reads } = await hosted();
		const held = holdFirstFetch();
		try {
			const first = host.hold(Reader, { caller: "first", board: "a", first: 2 }, context);
			await held.fetched;
			const later = host.hold(Reader, { caller: "later", board: "a", first: 2 }, context);
			await flushed();
			first.release();
			await flushed();
			held.release();
			await flushed();
			expect(later.notes.value.rows[0]).toMatchObject({ id: 3 });
			expect(reads()).toBe(2);
			later.release();
			await flushed();
			expect(reads()).toBe(0);
		} finally {
			held.release();
			await close();
		}
	});

	it("a provider's successor during a first run still held: every reader reads it (Astra)", async () => {
		const { host, close, reads } = await hosted();
		const held = holdFirstFetch();
		try {
			const first = host.hold(Reader, { caller: "first", board: "a", first: 2 }, context);
			await held.fetched;
			const later = host.hold(Reader, { caller: "later", board: "a", first: 2 }, context);
			await flushed();
			const reloading = host.reload([storePlugin("u"), readersPlugin], context);
			await flushed();
			held.release();
			await reloading;
			await flushed();
			for (const reader of [first, later]) expect(reader.notes.value.rows[0]).toMatchObject({ text: "u:n3" });
			expect(reads()).toBe(2);
			first.release();
			later.release();
		} finally {
			held.release();
			await close();
		}
	});

	it("arguments through a pending read and onto another shared one leave no subscription behind (Astra)", async () => {
		const { host, readers, close, reads } = await hosted();
		const [a] = await readers("a", 1);
		const b = await host.get(Reader, { caller: "b", board: "b", first: 2 }, context);
		const held = holdFirstFetch();
		try {
			const showing = a!.show("new", context);
			await held.fetched;
			await showing;
			await a!.show("b", context);
			await flushed();
			held.release();
			await flushed();
			expect(a!.notes.value).toBe(b.notes.value);
			expect(reads()).toBe(2);
			a!.release();
			b.release();
			await flushed();
			expect(reads()).toBe(0);
		} finally {
			held.release();
			await close();
		}
	});

	it("arguments that change and change back before the other read ran keep the read they have (Fable)", async () => {
		const { readers, notes, reads, close } = await hosted();
		const [reader] = await readers("a", 1);
		const calls = changesOf(await reader!.notes.watch(context));
		const value = reader!.notes.value;
		// No await between the two: the read of "b" is pending when the arguments are "a" again.
		await Promise.all([reader!.show("b", context), reader!.show("a", context)]);
		await flushed();
		await delivered();
		expect(reader!.notes.value).toBe(value);
		expect(calls).toEqual([]);
		expect(reads()).toBe(2);
		await notes.put({ id: 7, board: "a", text: "n7" }, context);
		await delivered();
		expect(calls).toHaveLength(1);
		await notes.put({ id: 8, board: "b", text: "n8" }, context);
		await delivered();
		expect(calls).toHaveLength(1);
		await close();
	});

	it("a commit's run adopted after the last reader left is decoded for nobody (Astra)", async () => {
		const { notes, readers, reads, close } = await hosted();
		const [reader] = await readers("a", 1);
		const held = holdFirstFetch();
		try {
			const before = mapped.count;
			const put = notes.put({ id: 4, board: "a", text: "n4" }, context);
			await held.fetched;
			reader!.release();
			await flushed();
			expect(reads()).toBe(0);
			held.release();
			await put;
			expect(mapped.count).toBe(before);
		} finally {
			held.release();
			await close();
		}
	});
});

describe("a failing shared read (round 1)", () => {
	it("fails every reader once, parks a later reader, and one good run heals them all (Opus repro 5, Astra)", async () => {
		const { host, notes, readers, reads, close } = await hosted();
		const decode = OwnQuery.prototype.decodeRow;
		OwnQuery.prototype.decodeRow = function (this: OwnQuery, ...args: Parameters<OwnQuery["decodeRow"]>) {
			if (args[1].text === "bad") throw new Error("bad note");
			return decode.apply(this, args);
		};
		try {
			const five = await readers("a", 5);
			const calls = await Promise.all(five.map(async (reader) => changesOf(await reader.notes.watch(context))));
			await notes.put({ id: 4, board: "a", text: "bad" }, context);
			await delivered();
			for (const reader of five) expect(() => reader.notes.value).toThrow("bad note");
			const late = host.hold(Reader, { caller: "late", board: "a", first: 2 }, context);
			await flushed();
			expect(late.state.value.kind).toBe("failed");
			expect(reads()).toBe(2);
			await notes.put({ id: 4, board: "a", text: "good" }, context);
			await delivered();
			for (const each of calls) {
				expect(each.map((call) => call.kind)).toEqual(["failed", "value"]);
				expect(each[1]).toMatchObject({ ops: [["r", five[0]!.notes.value]] });
			}
			await flushed();
			expect(late.notes.value).toBe(five[0]!.notes.value);
			late.release();
		} finally {
			OwnQuery.prototype.decodeRow = decode;
			await close();
		}
	});
});

describe("arguments as keys (round 1, Astra 4)", () => {
	it("a query's argument schema is JSON only: a contract's and a private query's with bytes() are refused", async () => {
		expect(() =>
			local("test.bytes", {
				version: 1,
				params: {},
				members: { q: queries(Note, { find: union([bytes(), obj({ "0": int() })]) }) },
			}),
		).toThrow("test.bytes.members.q.args.find: a query's arguments are JSON only (no bytes())");
		const Own = local("test.own-bytes", { version: 1, params: {}, members: { n: int() } });
		const store = await memoryStore();
		const errors: string[] = [];
		const host = createHost({ store, onError: () => {} });
		await host.load(
			[
				{
					name: "@test/own-bytes",
					facet: defineFacet((h) => {
						h.serve(Own, (_, self) => {
							try {
								self.queries(self.table(Notes), {}, { find: [bytes(), () => query(Notes)] });
							} catch (error) {
								errors.push((error as Error).message);
							}
							return { n: 0 as never };
						});
					}),
				},
			],
			context,
		);
		await host.get(Own, {}, context).catch(() => {});
		expect(errors).toEqual(['test.own-bytes: query "find": args: a query\'s arguments are JSON only (no bytes())']);
		await host.close(context);
		await store.close(context);
	});

	it("what is no JSON is refused as a query's arguments past a schema that checks nothing (Astra, round 2)", async () => {
		// Bytes and `{ "0": 7 }` have one canonical JSON: had both been taken, the second reader got the first's rows.
		const Find = local("test.find", {
			version: 1,
			params: {},
			members: { q: queries(Note, { find: unknown() }), seed: method() },
		});
		const Counting = local("test.counting", { version: 1, params: { asBytes: bool() }, members: { count: int() } });
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const facet = defineFacet((h) => {
			h.serve(Find, (_, self) => {
				const table = self.table(Notes);
				return {
					q: self.queries(
						table,
						{ map: (row) => ({ id: row.id, text: row.text }) },
						{ find: (x: unknown) => query(Notes).where((n) => eq(n.board, x instanceof Uint8Array ? "a" : "b")) },
					),
					seed: async (ctx) => {
						await self.tx(async (tx) => tx.put(table, { id: 1, board: "a", text: "n" }), ctx);
						return null;
					},
				};
			});
			h.serve(Counting, ({ asBytes }, self) => ({
				count: self.count(self.get(Find, {}).q.find, asBytes ? new Uint8Array([7]) : { "0": 7 }),
			}));
		});
		try {
			await host.load([{ name: "@test/find", facet }], context);
			await (await host.get(Find, {}, context)).seed(context);
			await expect(host.get(Counting, { asBytes: true }, context)).rejects.toMatchObject({
				code: "invalid",
				reason: "args",
				message: expect.stringContaining("a query's arguments are JSON only, not bytes"),
			});
			expect((await host.get(Counting, { asBytes: false }, context)).count.value).toBe(0);
		} finally {
			await host.close(context);
			await store.close(context);
		}
	});
});
