// Benchmarks of the store (slice 6a §14, decision "The commit-step benchmark"): the commit step against Durable's
// `SqliteStorage` on the same SQLite file settings, (a) one document delta per commit, (b) one table put per commit,
// (c) 1,000 whole transactions back to back (a host's `change` against a Durable Session's `commit`), with and without
// a watched document, and (d) transactions of one in-memory document only (no store); as bursts (median and p95 per
// commit over several runs) and the heap after GC; the outbox's extra cost apart. Then (e) the other costs: queue wait
// against step time, query pages, a 10k-row `updateWhere`'s step, long text per row, and migration chunks (the first
// and the late ones).
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/next/bench/store.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { defineDoc } from "../../../../durable/src/documents.ts";
import { createSession } from "../../../../durable/src/session/session.ts";
import { SqliteStorage } from "../../../../durable/src/storage/sqlite/storage.ts";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import { changeDocument, createDocument } from "../../../src/next/store/engine.ts";
import { lt } from "../../../src/next/store/expression.ts";
import { query } from "../../../src/next/store/query.ts";
import { TableSql, tableSqlName } from "../../../src/next/store/sql.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import { type ChordStore, openStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { TableChanges } from "../../../src/next/store/table-changes.ts";
import { evolveTable } from "../../../src/next/store/table-evolve.ts";
import { TableHandle } from "../../../src/next/store/table-handle.ts";
import { prepareTables } from "../../../src/next/store/table-migration.ts";
import { stagePut, stageTable } from "../../../src/next/store/table-writes.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";

const COMMITS = 1_000;
const RUNS = 7;

/** One commit as a benchmark makes it, given its index. */
type Commit = (index: number) => Promise<unknown>;

/** Per-commit times (ms) of `RUNS` bursts of `COMMITS` commits each, after one warm-up burst. */
async function bursts(setup: () => Promise<{ readonly commit: Commit; readonly close: () => Promise<void> }>) {
	const times: number[] = [];
	const perRun: number[] = [];
	for (let run = -1; run < RUNS; run++) {
		const { commit, close } = await setup();
		const started = performance.now();
		for (let index = 0; index < COMMITS; index++) {
			const before = performance.now();
			await commit(index);
			if (run >= 0) times.push(performance.now() - before);
		}
		if (run >= 0) perRun.push((performance.now() - started) / COMMITS);
		await close();
	}
	times.sort((a, b) => a - b);
	perRun.sort((a, b) => a - b);
	return {
		median: times[Math.floor(times.length / 2)]!,
		p95: times[Math.floor(times.length * 0.95)]!,
		burst: perRun[Math.floor(perRun.length / 2)]!,
	};
}

/** A fresh SQLite file in its own directory. */
async function file(): Promise<{ readonly path: string; readonly remove: () => Promise<void> }> {
	const directory = await mkdtemp(join(tmpdir(), "chord-store-bench-"));
	return { path: join(directory, "bench.sqlite"), remove: () => rm(directory, { recursive: true, force: true }) };
}

const VALUE = { title: "a note", body: "x".repeat(200), n: 0 };

/** Chord's store: one document created, then one delta per commit. */
function chordDeltas(outbox: boolean) {
	return async () => {
		const { path, remove } = await file();
		const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context, {
			outbox,
		})) as ChordStore;
		const address = { namespace: "chord", owner: "bench.store", kind: "note", key: "" };
		const base = { version: 1, fingerprint: "0123456789abcdef", value: VALUE };
		let id = 0;
		const fence = {
			admit: () => true,
			adopt: (_seq: number, ids: readonly number[]) => {
				id = ids[0] ?? id;
			},
		};
		await store.commit([createDocument(address, base, JSON.stringify(VALUE))], fence, context);
		return {
			commit: (index: number) => {
				const ops = [["s", ["n"], index + 1]] as const;
				return store.commit(
					[changeDocument(id, index + 1, { kind: "delta", version: 1, ops }, JSON.stringify(ops))],
					fence,
					context,
				);
			},
			close: async () => {
				await store.close(context);
				await remove();
			},
		};
	};
}

/** Durable's `SqliteStorage`: one session document created, then one delta per commit. */
async function durableDeltas() {
	const { path, remove } = await file();
	const storage = await SqliteStorage.open(await openNodeSqliteDatabase(path));
	const id = await storage.mintId();
	const record = { id, kind: "note", scope: { kind: "session" } } as never;
	await storage.commit(
		[{ type: "document.create", record, content: { kind: "base", version: 1, value: VALUE } }],
		() => {},
		context,
	);
	return {
		commit: (index: number) =>
			storage.commit(
				[
					{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["n"], index + 1]] } },
				] as never,
				() => {},
				context,
			),
		close: async () => {
			await storage.close(context);
			await remove();
		},
	};
}

const EDIT_COLUMNS = { id: str(), path: str(), at: int(), body: str() };
const Edits = defineTable("edits", { version: 1, columns: EDIT_COLUMNS, key: ["id"] });
/** `Edits` with an index, for pages in a non-key order. */
const IndexedEdits = defineTable("edits", {
	version: 1,
	columns: EDIT_COLUMNS,
	key: ["id"],
	indexes: { by_at: ["at"] },
});

/** Chord's store: one table created, then one `put` per commit (the row checked and encoded in the commit). */
function chordPuts(outbox: boolean) {
	return async () => {
		const { path, remove } = await file();
		const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context, {
			outbox,
		})) as ChordStore;
		const table = tableSqlName("bench.store", Edits.name);
		const sql = new TableSql(table, Edits.columns, Edits.rows.physical, Edits.key);
		const fence = { admit: () => true, adopt: () => {} };
		const { version, record: columns, key, fingerprint } = Edits;
		await store.commit(
			[stageTable({ kind: "table", table, version, state: "ready", columns, key, fingerprint })],
			fence,
			context,
		);
		return {
			commit: (index: number) => {
				const row = Edits.rows.put(
					{ id: `e${index}`, path: `src/file${index % 50}.ts`, at: index, body: VALUE.body },
					version,
				);
				return store.commit([stagePut(sql.put, table, row, version)], fence, context);
			},
			close: async () => {
				await store.close(context);
				await remove();
			},
		};
	};
}

/** Durable's `SqliteStorage`: one conversation created, then one entry appended per commit. */
async function durableEntries() {
	const { path, remove } = await file();
	const storage = await SqliteStorage.open(await openNodeSqliteDatabase(path));
	await storage.commit([{ type: "conversation", value: { id: 1 } }] as never, () => {}, context);
	return {
		commit: async (index: number) => {
			const id = await storage.mintId();
			const data = { path: `src/file${index % 50}.ts`, at: index, body: VALUE.body };
			return storage.commit(
				[{ type: "entry", value: { id, conversationId: 1, kind: "edit", data } }] as never,
				() => {},
				context,
			);
		},
		close: async () => {
			await storage.close(context);
			await remove();
		},
	};
}

/** The heap after GC, in KiB. */
const NoteSchema = obj({ title: str(), body: str(), n: int() });

const InMemoryNote = defineState("bench.note", { schema: NoteSchema, version: 1, initial: () => ({ ...VALUE }) });

const PersistedNote = defineState("bench.note", {
	schema: NoteSchema,
	version: 1,
	initial: () => ({ ...VALUE }),
	persist: true,
	checkpointWhen: () => false,
});

const Counter = local("bench.counter", { version: 1, params: {}, members: { touch: method() } });

/** Whole Chord transactions on a host: one `change` of one document per commit, persisted or in memory, watched or not. */
function chordTransactions(options: {
	readonly persist: boolean;
	readonly watched: boolean;
	readonly outbox: boolean;
}) {
	return async () => {
		const { path, remove } = await file();
		const store = options.persist
			? await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context, { outbox: options.outbox })
			: undefined;
		let note: SingletonHandle<typeof VALUE> | undefined;
		const host = createHost({ store, onError: () => {} });
		const facet = defineFacet((h) =>
			h.serve(Counter, (_, self) => {
				note = self.state(options.persist ? PersistedNote : InMemoryNote);
				return { touch: async () => null };
			}),
		);
		await host.load([{ name: "@bench/store", facet }], context);
		const reference = await host.get(Counter, {}, context);
		await note!.change((draft) => {
			draft.n = -1;
		}, context);
		const watch = options.watched ? await note!.watch(context) : undefined;
		watch?.start(async () => {});
		return {
			commit: (index: number) =>
				note!.change((draft) => {
					draft.n = index + 1;
				}, context),
			close: async () => {
				await watch?.stop();
				reference.release();
				await host.close(context);
				await store?.close(context);
				await remove();
			},
		};
	};
}

const DurableNote = defineDoc<typeof VALUE>({
	kind: "bench.note",
	version: 1,
	scope: "session",
	initial: () => ({ ...VALUE }),
	checkpointWhen: () => false,
});

/** Whole Durable transactions on a Session over `SqliteStorage`: one document change per commit, watched or not. */
function durableTransactions(watched: boolean) {
	return async () => {
		const { path, remove } = await file();
		const storage = await SqliteStorage.open(await openNodeSqliteDatabase(path));
		const session = createSession(storage);
		await session.commit(async (tx) => {
			(await tx.doc(DurableNote)).n = -1;
		}, context);
		const watch = watched ? await session.watchDoc(DurableNote, context) : undefined;
		watch?.start(async () => {});
		return {
			commit: (index: number) =>
				session.commit(async (tx) => {
					(await tx.doc(DurableNote)).n = index + 1;
				}, context),
			close: async () => {
				await watch?.stop();
				await session.close(context);
				await remove();
			},
		};
	};
}

function heap(): number {
	globalThis.gc?.();
	return Math.round(process.memoryUsage().heapUsed / 1024);
}

const format = ({ median, p95, burst }: { median: number; p95: number; burst: number }) =>
	`median ${(median * 1000).toFixed(1)} µs, p95 ${(p95 * 1000).toFixed(1)} µs, burst ${(burst * 1000).toFixed(1)} µs/commit`;

const before = heap();
const durable = await bursts(durableDeltas);
const chord = await bursts(chordDeltas(false));
const outbox = await bursts(chordDeltas(true));
console.log(`(a, c) one document delta per commit, ${RUNS} bursts of ${COMMITS}:`);
console.log(`  Durable SqliteStorage: ${format(durable)}`);
console.log(`  Chord store:           ${format(chord)}`);
console.log(`  Chord store + outbox:  ${format(outbox)}`);
const durablePuts = await bursts(durableEntries);
const chordTable = await bursts(chordPuts(false));
const tableOutbox = await bursts(chordPuts(true));
console.log(`(b) one table put (Durable: one entry append) per commit, ${RUNS} bursts of ${COMMITS}:`);
console.log(`  Durable SqliteStorage: ${format(durablePuts)}`);
console.log(`  Chord store:           ${format(chordTable)}`);
console.log(`  Chord store + outbox:  ${format(tableOutbox)}`);
for (const watched of [false, true]) {
	const durableTx = await bursts(durableTransactions(watched));
	const chordTx = await bursts(chordTransactions({ persist: true, watched, outbox: false }));
	const chordTxOutbox = await bursts(chordTransactions({ persist: true, watched, outbox: true }));
	console.log(`(c) whole transactions, ${watched ? "a watched document" : "no watch"}, ${RUNS} bursts of ${COMMITS}:`);
	console.log(`  Durable Session:       ${format(durableTx)}`);
	console.log(`  Chord host:            ${format(chordTx)}`);
	console.log(`  Chord host + outbox:   ${format(chordTxOutbox)}`);
}
const memory = await bursts(chordTransactions({ persist: false, watched: false, outbox: false }));
const memoryWatched = await bursts(chordTransactions({ persist: false, watched: true, outbox: false }));
console.log(`(d) one in-memory document per transaction (no store), ${RUNS} bursts of ${COMMITS}:`);
console.log(`  Chord host:            ${format(memory)}`);
console.log(`  Chord host, watched:   ${format(memoryWatched)}`);
console.log(`heap after GC: ${heap() - before} KiB above the start`);

/** A file store with `count` rows of `Edits` at version 1 (one commit), as a table handle. */
async function filledEdits(count: number, body = VALUE.body, definition: typeof Edits = Edits) {
	const { path, remove } = await file();
	const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
	const table = tableSqlName("bench.store", Edits.name);
	const fence = { admit: () => true, adopt: () => {} };
	await prepareTables([{ definition, table }], store, fence, "bench", context);
	const handle = new TableHandle(definition, table, store, {
		label: "bench",
		scope: {},
		assertLive: () => {},
		fail: () => {},
	});
	const staged: StagedWrite[] = [];
	const changes = new TableChanges(handle, staged);
	for (let i = 0; i < count; i++)
		changes.put({ id: `e${String(i).padStart(6, "0")}`, path: `src/f${i % 50}.ts`, at: i, body });
	await store.commit(staged, fence, context);
	return {
		store,
		table,
		handle,
		fence,
		close: async () => {
			await store.close(context);
			await remove();
		},
	};
}

/** The median of `values`. */
function median(values: number[]): number {
	values.sort((a, b) => a - b);
	return values[Math.floor(values.length / 2)]!;
}

console.log("(e) other costs:");
{
	// 100 commits submitted at once: the time each waits in the queue, apart from its own step.
	const { store, table, fence, close } = await filledEdits(0);
	const sql = new TableSql(table, Edits.columns, Edits.rows.physical, Edits.key);
	const waits: number[] = [];
	const steps: number[] = [];
	await Promise.all(
		Array.from({ length: 100 }, async (_, index) => {
			const row = Edits.rows.put({ id: `q${index}`, path: "p", at: index, body: VALUE.body }, 1);
			const put = stagePut(sql.put, table, row, 1);
			const submitted = performance.now();
			let started = 0;
			const timed: StagedWrite = {
				order: put.order,
				apply: (step) => {
					started = performance.now();
					return put.apply(step);
				},
			};
			await store.commit([timed], fence, context);
			waits.push(started - submitted);
			steps.push(performance.now() - started);
		}),
	);
	console.log(
		`  queue: 100 commits at once, median wait ${(median(waits) * 1000).toFixed(0)} µs, step ${(median(steps) * 1000).toFixed(1)} µs`,
	);
	await close();
}
{
	const { handle, close } = await filledEdits(10_000, VALUE.body, IndexedEdits);
	const q = query(IndexedEdits).orderBy((e) => e.at, "desc");
	let after: string | undefined;
	const started = performance.now();
	for (let page = 0; page < 100; page++) {
		const result = await handle.page(q, 100, context, after === undefined ? {} : { after });
		after = result.next;
	}
	console.log(
		`  query pages: 100 rows in an index's order, ${((performance.now() - started) * 10).toFixed(0)} µs per page`,
	);
	await close();
}
{
	const { store, handle, fence, close } = await filledEdits(10_000);
	const staged: StagedWrite[] = [];
	new TableChanges(handle, staged).updateWhere((e: { at: never }) => lt(e.at, 10_000 as never), { path: "moved" });
	const started = performance.now();
	await store.commit(staged, fence, context);
	console.log(
		`  updateWhere over 10,000 rows: one step of ${(performance.now() - started).toFixed(1)} ms (every owner's commits wait)`,
	);
	await close();
}
for (const length of [10, 10_000]) {
	const body = "ü".repeat(length);
	const started = performance.now();
	const { close } = await filledEdits(2_000, body);
	console.log(
		`  text: 2,000 puts with ${length}-character cells, ${(((performance.now() - started) / 2_000) * 1000).toFixed(1)} µs per row`,
	);
	await close();
}
{
	const { store, table, fence, close } = await filledEdits(10_000);
	const EditsV2 = evolveTable(Edits, (t) =>
		t.add("dir", str({ default: "" })).rows((row) => ({ dir: row.path.slice(0, 3) })),
	);
	const chunks: number[] = [];
	const commit = store.commit.bind(store);
	store.commit = async (writes, commitFence, commitContext) => {
		const started = performance.now();
		const seq = await commit(writes, commitFence, commitContext);
		chunks.push(performance.now() - started);
		return seq;
	};
	const started = performance.now();
	await prepareTables([{ definition: EditsV2, table }], store, fence, "bench", context);
	const total = performance.now() - started;
	const rows = chunks.slice(1, -1);
	console.log(
		`  migration (rows) of 10,000 rows: ${total.toFixed(0)} ms, ${((total / 10_000) * 1000).toFixed(1)} µs per row; ` +
			`chunk commits: first ${rows[0]!.toFixed(2)} ms, last ${rows.at(-1)!.toFixed(2)} ms, median ${median(rows).toFixed(2)} ms`,
	);
	await close();
}
