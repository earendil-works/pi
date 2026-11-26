// Tests of shared live reads (`src/store/shared-read.ts`; decision "Identical live reads share one source"): readers of
// the same provider instance's named query with the same arguments and shape share one read: one entry in the store's
// index, one run, one decode and one value per write. Arguments that change move a reader between reads, the
// provider's restart moves every reader to one read of its successor, a shared run is counted once, and a read goes
// once its last reader did.
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { arr, bool, int, local, method, obj, queries, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet, type FacetHost, type Host } from "../../src/host/index.ts";
import { eq } from "../../src/store/expression.ts";
import { query } from "../../src/store/query.ts";
import { SharedRead } from "../../src/store/shared-read.ts";
import { defineTable } from "../../src/store/table.ts";
import { expectCollected, flushed, instancesOf, memoryStore, metered } from "../support.ts";

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
	const reads = (): number => store.reads.on(TABLE)?.size ?? 0;
	const close = async (): Promise<void> => {
		await host.close(context);
		await store.close(context);
	};
	return { host, store, notes, readers, runs, reads, close, metered: meter.context };
}

/** The shared reads made since `from` (an index into `shared`), each once. */
function madeSince(from: number): SharedRead[] {
	return [...new Set(shared.slice(from).map((ref) => ref.deref()!))];
}

describe("one source per query, arguments and shape", () => {
	it("readers of the same query, arguments and window share one read: one run per write, one value", async () => {
		const { notes, readers, runs, reads, close, metered } = await hosted();
		const from = shared.length;
		const five = await readers("a", 5);
		// One read of the window and one of the count, for all five.
		expect(madeSince(from)).toHaveLength(2);
		expect(reads()).toBe(2);
		const before = runs();
		const decoded = mapped.count;
		// Counted in the write's context.
		await notes.put({ id: 4, board: "a", text: "n4" }, metered);
		expect(runs() - before).toBe(2);
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
		await host.reload([storePlugin("u"), readersPlugin], context);
		await flushed();
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
