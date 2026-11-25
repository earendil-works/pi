// The commit index (slice 15 §3): a commit skip-tests only the reads its writes can concern. A read is filed by the
// values its condition fixes on its own table (its bucket) and by the keys of its last result; any other read is a
// candidate of every write. The differential check: over random commits of 1 to 5,000 writes every read stays equal to
// a fresh run of its statement, and an index that leaves out its bucket lookups fails it.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../src/context/index.ts";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { int, str } from "../../src/contracts/index.ts";
import { Batch } from "../../src/state/internal.ts";
import { and, eq, inArray } from "../../src/store/expression.ts";
import { OpenQuery, type OpenRead } from "../../src/store/open-query.ts";
import { type Query, query } from "../../src/store/query.ts";
import { identityOf, type Read, type ReadKind, type ReadRun } from "../../src/store/read.ts";
import { ReadIndex } from "../../src/store/read-index.ts";
import { ReadRefresh } from "../../src/store/reads.ts";
import type { KeyedChange } from "../../src/store/skip.ts";
import type { StagedWrite } from "../../src/store/step.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import { TableChanges } from "../../src/store/table-changes.ts";
import type { TableHandle } from "../../src/store/table-handle.ts";
import { expectCollected, memoryStore, metered, tableIn } from "../support.ts";
import {
	closeWorld,
	commit,
	opened,
	openRead,
	PERSONS,
	random,
	randomWrite,
	SessionColumns,
	Sessions,
	staleReads,
	type World,
} from "./read-world.ts";

// A session's entries: the table of the bench's case (a write to one session's row, reads of every other session).
const Entries = defineTable("entries", {
	version: 1,
	columns: { session: str(), id: int(), kind: str(), text: str() },
	key: ["session", "id"],
	indexes: { by_kind: ["kind", "id"] },
});

let store: ChordStore | undefined;
afterEach(async () => {
	await store?.close(BACKGROUND_CONTEXT);
	store = undefined;
	await closeWorld();
});

/** Opens `count` reads of `handle`'s table, the `index`th with `q(index)`, each loaded; their runs counted. */
async function openReads(handle: TableHandle, count: number, q: (index: number) => Query, what?: ReadKind) {
	const batch = new Batch(() => {}, undefined);
	const owner = {};
	const queries: OpenQuery[] = [];
	const opens: OpenRead[] = [];
	const runs: ReadRun[][] = [];
	for (let index = 0; index < count; index++) {
		const spec = { query: q(index), table: handle.sql.table, projection: {}, owner };
		const opened = new OpenQuery({ store: store!, batch }, spec, what?.kind ?? "rows", () => {}, BACKGROUND_CONTEXT);
		const adopted: ReadRun[] = [];
		const open = opened.read(what ?? { kind: "rows", range: { limit: 20 } }, {
			adopt: (run) => void adopted.push(run),
		});
		await open.load();
		queries.push(opened);
		opens.push(open);
		runs.push(adopted);
	}
	return { queries, opens, runs, batch };
}

/** A context whose counters can be read. */
type Meter = Awaited<ReturnType<typeof metered>>;

/** Commits `write`'s writes to `handle`'s table with the refresh a transaction stages; resolves with its costs. */
async function costOf(handle: TableHandle, batch: Batch, meter: Meter, write: (changes: TableChanges) => void) {
	const { context } = meter;
	const before = meter.counts();
	const staged: StagedWrite[] = [];
	const changes = new TableChanges(handle, staged);
	write(changes);
	const refresh = new ReadRefresh(store!.reads, [handle.sql.table], () => changes.changes(), context);
	staged.push(refresh.write);
	await store!.commit(
		staged,
		{ admit: () => true, adopt: () => batch.commit(() => refresh.adopt(), context) },
		context,
	);
	const after = meter.counts();
	const of = (name: string): number => (after[name] ?? 0) - (before[name] ?? 0);
	return {
		runs: of("chord.query.runs"),
		probes: of("chord.query.probes"),
		skips: of("chord.query.skips"),
		statements: of("chord.store.statements"),
	};
}

describe("candidates", () => {
	it("a write to one session's row with 10,000 open reads of other sessions tests none of them", async () => {
		store = await memoryStore();
		const entries = await tableIn(store, Entries);
		const sessions = (index: number) => query(Entries).where((e) => eq(e.session, `s${index}`));
		const { batch, runs } = await openReads(entries, 10_000, sessions);
		const meter = await metered();
		// A new row of session 0: its read alone is a candidate; its probe finds the row and it runs.
		const write = (changes: TableChanges) => changes.put({ session: "s0", id: 1, kind: "note", text: "hi" });
		// The bucket fixes a key column: no row is read back. Statements: the commit's own, the put, the probe, the run.
		expect(await costOf(entries, batch, meter, write)).toEqual({ runs: 1, probes: 1, skips: 0, statements: 4 });
		expect(runs[0]!.at(-1)).toMatchObject({ kind: "rows", result: { rows: [{ id: 1 }] } });
		// Its update: the read holds the key, nobody else is asked.
		const update = (changes: TableChanges) => changes.update({ session: "s0", id: 1 }, { text: "hello" });
		expect(await costOf(entries, batch, meter, update)).toEqual({ runs: 1, probes: 0, skips: 0, statements: 3 });
	}, 60_000);

	it("a bucket on a column outside the key reads the written row back once per key, in the step", async () => {
		store = await memoryStore();
		const entries = await tableIn(store, Entries);
		const kinds = ["note", "task", "link"];
		const { batch, runs } = await openReads(entries, 3, (index) =>
			query(Entries).where((e) => eq(e.kind, kinds[index]!)),
		);
		const meter = await metered();
		// Two writes of one key: one lookup; only the tasks' read is a candidate. Statements: the commit's own, the two
		// writes, the lookup, the probe, the run.
		const write = (changes: TableChanges) => {
			changes.put({ session: "s0", id: 1, kind: "task", text: "a" });
			changes.update({ session: "s0", id: 1 }, { text: "b" });
		};
		expect(await costOf(entries, batch, meter, write)).toEqual({ runs: 1, probes: 1, skips: 0, statements: 6 });
		expect(runs.map((each) => each.length)).toEqual([1, 2, 1]);
		// It moves to the notes: the tasks' read held it before, the notes' read finds it after.
		const moved = (changes: TableChanges) => changes.update({ session: "s0", id: 1 }, { kind: "note" });
		expect(await costOf(entries, batch, meter, moved)).toEqual({ runs: 2, probes: 1, skips: 0, statements: 6 });
		expect(runs.map((each) => each.length)).toEqual([2, 3, 1]);
		// Deleted: no row after, no lookup; the notes' read held it.
		const deleted = (changes: TableChanges) => changes.delete({ session: "s0", id: 1 });
		expect(await costOf(entries, batch, meter, deleted)).toEqual({ runs: 1, probes: 0, skips: 0, statements: 3 });
	});

	it("an `in` files a read once per value, up to 32 combinations; a column past that is left out of its bucket", async () => {
		store = await memoryStore();
		const entries = await tableIn(store, Entries);
		const many = Array.from({ length: 33 }, (_, index) => `k${index}`);
		const shapes = [
			query(Entries).where((e) => inArray(e.session, ["s1", "s2"])),
			// 2 × 33 combinations: `kind` is left out, the read is filed by its sessions alone.
			query(Entries).where((e) => and(inArray(e.session, ["s3", "s4"]), inArray(e.kind, many))),
			// Nothing left: unindexed, a candidate of every write.
			query(Entries).where((e) => inArray(e.kind, many)),
		];
		const { batch } = await openReads(entries, shapes.length, (index) => shapes[index]!);
		const meter = await metered();
		const put = (session: string) => (changes: TableChanges) =>
			changes.put({ session, id: 1, kind: "other", text: "" });
		// s2: the first read's probe finds the row; the unindexed one's misses (`other` is none of its kinds).
		expect(await costOf(entries, batch, meter, put("s2"))).toMatchObject({ runs: 1, probes: 2, skips: 1 });
		// s4: the second read is a candidate by its sessions, the third as always; both probes miss.
		expect(await costOf(entries, batch, meter, put("s4"))).toMatchObject({ runs: 0, probes: 2, skips: 2 });
		// s9: the third read alone.
		expect(await costOf(entries, batch, meter, put("s9"))).toMatchObject({ runs: 0, probes: 1, skips: 1 });
	});

	it("an empty `in` is filed under no bucket: closing one leaves another read's bucket alone (review round 1, Astra 1)", async () => {
		store = await memoryStore();
		const entries = await tableIn(store, Entries);
		const of = (sessions: string[]) => () => query(Entries).where((e) => inArray(e.session, sessions));
		const [a, b] = [await openReads(entries, 1, of([])), await openReads(entries, 1, of([]))];
		a.queries[0]!.close();
		const c = await openReads(entries, 1, of(["s1"]));
		b.queries[0]!.close();
		await costOf(entries, c.batch, await metered(), (changes) =>
			changes.put({ session: "s1", id: 1, kind: "note", text: "" }),
		);
		expect(c.runs[0]!.at(-1)).toMatchObject({ kind: "rows", result: { rows: [{ id: 1 }] } });
	});

	it("files a data condition's strings as SQLite binds them (review round 1, Astra 2)", async () => {
		// A node's operands are checked, not normalized: a lone surrogate is U+FFFD once bound, and so in the row.
		const meter = await metered();
		const w = await opened(meter.context, []);
		const node = { eq: ["creator", "\uD800"] } as const;
		const shape = { name: "lone", query: query(Sessions).whereNode(SessionColumns, node), table: Sessions };
		await openRead(w, { ...shape, what: { kind: "rows", range: { limit: 5 } } }, meter.context);
		const row = { id: "s1", app: "club", creator: "\uD800", private: false, state: "idle", lastTouch: 1, title: "" };
		await commit(w, meter.context, (changes) => changes(Sessions).put(row));
		expect(await staleReads(w, meter.context)).toEqual([]);
		expect(w.reads[0]!.latest).toMatchObject({ kind: "rows", result: { rows: [{ id: "s1" }] } });
	});

	it("a count, a read without an equality, and a bulk write: candidates of every write", async () => {
		store = await memoryStore();
		const entries = await tableIn(store, Entries);
		const count = await openReads(entries, 1, () => query(Entries).where((e) => eq(e.session, "s1")), {
			kind: "count",
		});
		const all = await openReads(entries, 1, () => query(Entries));
		const mine = await openReads(entries, 1, () => query(Entries).where((e) => eq(e.session, "s1")));
		const meter = await metered();
		// A row of another session: the count keeps no keys and runs, the read of everything probes and runs.
		const put = (changes: TableChanges) => changes.put({ session: "s2", id: 1, kind: "note", text: "" });
		expect(await costOf(entries, count.batch, meter, put)).toMatchObject({ runs: 2, skips: 0 });
		expect([all.runs[0]!.length, mine.runs[0]!.length]).toEqual([2, 1]);
		// A bulk write names no rows: every read of the table is tested, s1's too (an `updateWhere` of `text` changes no
		// count; the reads of rows map it and run).
		expect(mine.runs[0]).toHaveLength(1);
		const bulk = (changes: TableChanges) =>
			changes.updateWhere((e: typeof Entries.refs) => eq(e.kind as never, "note"), { text: "x" });
		expect(await costOf(entries, count.batch, meter, bulk)).toMatchObject({ runs: 2, skips: 1 });
		expect(mine.runs[0]).toHaveLength(2);
	});

	it("a read without a result is a candidate of every write until it has one", async () => {
		store = await memoryStore();
		const entries = await tableIn(store, Entries);
		const batch = new Batch(() => {}, undefined);
		const spec = {
			query: query(Entries).where((e) => eq(e.session, "s1")),
			table: entries.sql.table,
			projection: {},
			owner: {},
		};
		const opened = new OpenQuery({ store, batch }, spec, "rows", () => {}, BACKGROUND_CONTEXT);
		const runs: ReadRun[] = [];
		// Registered, not loaded: a commit of another session's row runs it.
		opened.read({ kind: "rows", range: { limit: 5 } }, { adopt: (run) => void runs.push(run) });
		const meter = await metered();
		const put = (id: number) => (changes: TableChanges) => changes.put({ session: "s2", id, kind: "note", text: "" });
		expect(await costOf(entries, batch, meter, put(1))).toMatchObject({ runs: 1, probes: 0, skips: 0 });
		// With a result, the next one leaves it out.
		expect(await costOf(entries, batch, meter, put(2))).toMatchObject({ runs: 0, probes: 0, skips: 0 });
		expect(runs).toHaveLength(1);
		opened.close();
	});

	it("a closed read leaves no entry: no commit tests it, and it is collected", async () => {
		store = await memoryStore();
		const entries = await tableIn(store, Entries);
		const { queries, opens, batch } = await openReads(entries, 1, () =>
			query(Entries).where((e) => eq(e.kind, "note")),
		);
		const meter = await metered();
		const put = (id: number) => (changes: TableChanges) => changes.put({ session: "s1", id, kind: "note", text: "" });
		await costOf(entries, batch, meter, put(1));
		const read = new WeakRef(opens[0]!.read!);
		queries[0]!.close();
		expect(store.reads.on(entries.sql.table)).toBeUndefined();
		// The commit's own statement and the put.
		expect(await costOf(entries, batch, meter, put(2))).toMatchObject({
			runs: 0,
			probes: 0,
			skips: 0,
			statements: 2,
		});
		queries.length = 0;
		opens.length = 0;
		await expectCollected(read);
	});
});

/** Commit sizes of the differential check: mostly a few writes, now and then an import's. */
const SIZES = [1, 1, 2, 3, 5, 20, 200, 1000, 5000];

/**
 * Runs `steps` random commits of 1 to 5,000 writes over `w`, re-opening "created by" for another person now and then
 * (a list whose arguments changed); resolves with the stale reads found after each commit.
 */
async function differential(w: World, seed: number, steps: number, context: Context): Promise<string[]> {
	const r = random(seed);
	let clock = 6000;
	const stale: string[] = [];
	// Reads opened and closed in turn over one bucket shape, an empty `in` among them (review round 1, Astra 1).
	let turned: World["reads"][number][] = [];
	const close = (read: World["reads"][number]): void => {
		read.query.close();
		w.reads.splice(w.reads.indexOf(read), 1);
	};
	const idle = (name: string, creators: string[], step: number) => ({
		name: `${name} (${step})`,
		query: query(Sessions)
			.where((s) => and(eq(s.state, "idle"), inArray(s.creator, creators)))
			.orderBy((s) => s.lastTouch, "desc"),
		table: Sessions,
		what: { kind: "rows", range: { limit: 3 } } as const,
	});
	for (let step = 0; step < steps; step++) {
		const size = r.pick(SIZES);
		await commit(w, context, (changes) => {
			for (let index = 0; index < size; index++) randomWrite(r, changes, clock++);
		});
		if (step % 5 === 4) {
			const person = r.pick(PERSONS);
			const reopened = query(Sessions)
				.where((s) => and(eq(s.app, "club"), eq(s.creator, person)))
				.orderBy((s) => s.lastTouch, "desc");
			await openRead(
				w,
				{
					name: `created by ${person} (${step})`,
					query: reopened,
					table: Sessions,
					what: { kind: "rows", range: { limit: 3 } },
				},
				context,
			);
			const empty = await openRead(w, idle("idle of nobody", [], step), context);
			const [previous, previousEmpty] = turned;
			if (previous !== undefined) close(previous);
			const some = await openRead(w, idle("idle", [r.pick(PERSONS)], step), context);
			if (previousEmpty !== undefined) close(previousEmpty);
			turned = [some, empty];
		}
		for (const name of await staleReads(w, context)) stale.push(`step ${step}: ${name}`);
	}
	return stale;
}

describe("the differential check", () => {
	for (const seed of [11, 12, 13, 14]) {
		it(`every read stays equal to a fresh run over commits of 1 to 5,000 writes (seed ${seed})`, async () => {
			const meter = await metered();
			const w = await opened(meter.context);
			expect(await differential(w, seed, 40, meter.context)).toEqual([]);
			const counts = meter.counts();
			expect(counts["chord.query.skips"]).toBeGreaterThan(100);
			expect(counts["chord.query.runs"]).toBeGreaterThan(100);
		}, 60_000);
	}

	it("fails for an index that leaves out its bucket lookups (the mutation check)", async () => {
		// The mutant keeps only the writes whose key a read held: a row entering a read's result goes unseen.
		const candidates = ReadIndex.prototype.candidates;
		vi.spyOn(ReadIndex.prototype, "candidates").mockImplementation(async function (
			this: ReadIndex,
			table: string,
			changes: readonly KeyedChange[],
			step,
			into: Map<Read, KeyedChange[]>,
		) {
			const before = new Set(into.keys());
			const unindexed = await candidates.call(this, table, changes, step, into);
			for (const [read, its] of into) {
				if (before.has(read)) continue;
				const kept = read.kept() ?? [];
				const key = read.plan.query.table.key;
				const held = its.filter((change) =>
					kept.some((keys) => keys.has(identityOf(key.map((name) => change.key[name]!)))),
				);
				if (held.length === 0) into.delete(read);
				else into.set(read, held);
			}
			return unindexed;
		});
		try {
			const meter = await metered();
			const w = await opened(meter.context);
			expect((await differential(w, 11, 40, meter.context)).length).toBeGreaterThan(0);
		} finally {
			vi.restoreAllMocks();
		}
	}, 60_000);
});
