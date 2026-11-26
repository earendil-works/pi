// Benchmark of the commit index (slice 15 §3): what one commit costs the open reads of a store when most of them read
// other sessions. Case 1: one write to one session's row with 10,000 open reads, one per session (a server holding
// every session's list). Case 2: an import of 3,549 rows into one session with 4,020 open reads (bench round 1's
// case). For each: the reads skip-tested (candidates), skipped, probed and run (exact, from the counters) and the
// median time of the commit. Case 3 (the hot-path pass): the heap one open read keeps, the index's filing included,
// at case 1's world (after collections; the rows are in SQLite, not on the heap). Runs on the store's reads directly (open queries, a transaction's refresh), on SQLite
// `:memory:`.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/bench/commit-index.ts
import { performance } from "node:perf_hooks";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, type Context, withTelemetry } from "../../src/context/index.ts";
import { int, str } from "../../src/contracts/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { Batch } from "../../src/state/internal.ts";
import { sqliteBackend } from "../../src/store/backend.ts";
import { eq } from "../../src/store/expression.ts";
import { OpenQuery } from "../../src/store/open-query.ts";
import { query } from "../../src/store/query.ts";
import { ReadRefresh } from "../../src/store/reads.ts";
import type { StagedWrite } from "../../src/store/step.ts";
import { type ChordStore, openStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import { TableChanges } from "../../src/store/table-changes.ts";
import { TableHandle } from "../../src/store/table-handle.ts";
import { prepareTables } from "../../src/store/table-migration.ts";

const RUNS = 7;

const Entries = defineTable("entries", {
	version: 1,
	columns: { session: str(), id: int(), kind: str(), text: str() },
	key: ["session", "id"],
});

/** A store with the entries table, `sessions` sessions of `rows` rows each, and one open read per session. */
async function world(sessions: number, rows: number) {
	const store = (await openStore(
		sqliteBackend(await openNodeSqliteDatabase(":memory:")),
		BACKGROUND_CONTEXT,
	)) as ChordStore;
	const table = "app.store:entries";
	const fence = { admit: () => true, adopt: () => {} };
	await prepareTables([{ definition: Entries, table }], store, fence, "app.store", BACKGROUND_CONTEXT);
	const owner = { label: "app.store", scope: {}, assertLive: () => {}, fail: () => {} };
	const handle = new TableHandle(Entries, table, store, owner as never);
	const batch = new Batch(() => {}, undefined);
	await commit(store, handle, batch, BACKGROUND_CONTEXT, (changes) => {
		for (let session = 0; session < sessions; session++) {
			for (let id = 0; id < rows; id++) changes.put({ session: `s${session}`, id, kind: "note", text: "a line" });
		}
	});
	for (let session = 0; session < sessions; session++) {
		const spec = {
			query: query(Entries).where((e) => eq(e.session, `s${session}`)),
			table,
			projection: {},
			owner: handle,
		};
		const opened = new OpenQuery({ store, batch }, spec, "rows", { rebound: () => {} }, BACKGROUND_CONTEXT);
		await opened.read({ kind: "rows", range: { limit: 20 } }, { adopt: () => {} }).load(BACKGROUND_CONTEXT);
	}
	return { store, handle, batch };
}

/** One commit of `write` with the refresh a transaction stages. */
async function commit(
	store: ChordStore,
	handle: TableHandle,
	batch: Batch,
	context: Context,
	write: (changes: TableChanges) => void,
): Promise<void> {
	const staged: StagedWrite[] = [];
	const changes = new TableChanges(handle, staged);
	write(changes);
	const refresh = new ReadRefresh(store.reads, [handle.sql.table], () => changes.changes(), context);
	staged.push(refresh.write);
	await store.commit(
		staged,
		{ admit: () => true, adopt: () => batch.commit(() => refresh.adopt(), context) },
		context,
	);
}

/** The counters and the median time of `RUNS` commits of `write(run)`, after one warm-up. */
async function measure(
	label: string,
	sessions: number,
	rows: number,
	write: (changes: TableChanges, run: number) => void,
): Promise<void> {
	const { store, handle, batch } = await world(sessions, rows);
	const times: number[] = [];
	let counts: Record<string, number> = {};
	for (let run = -1; run < RUNS; run++) {
		const telemetry = new InMemoryTelemetryContext();
		// A settled span still records through its adapter's metrics.
		const context = withTelemetry(await telemetry.startSpan({ name: "bench" }, (span) => span), BACKGROUND_CONTEXT);
		const started = performance.now();
		await commit(store, handle, batch, context, (changes) => write(changes, run));
		if (run >= 0) times.push(performance.now() - started);
		counts = {};
		for (const { name, value } of telemetry.getMetrics()) counts[name] = (counts[name] ?? 0) + value;
	}
	times.sort((a, b) => a - b);
	const of = (name: string): number => counts[`chord.query.${name}`] ?? 0;
	console.log(
		`${label}: candidates ${of("skips") + of("runs")}, skips ${of("skips")}, probes ${of("probes")}, runs ${of("runs")}, median ${times[Math.floor(times.length / 2)]!.toFixed(2)} ms`,
	);
	await store.close(BACKGROUND_CONTEXT);
}

await measure("1. one write to one session's row, 10,000 reads of other sessions", 10_000, 3, (changes, run) =>
	changes.update({ session: "s0", id: 0 }, { text: `edited ${run}` }),
);
await measure("2. an import of 3,549 rows into one session, 4,020 reads", 4_020, 3, (changes, run) => {
	for (let id = 0; id < 3_549; id++)
		changes.put({ session: "s1", id: 1_000 + id + run * 10_000, kind: "note", text: "imported" });
});

/** The heap one open read keeps in a world of 10,000 sessions of 3 rows, one read each, after a warm-up world. */
async function heapPerRead(): Promise<void> {
	const settled = async (): Promise<number> => {
		for (let round = 0; round < 6; round++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			globalThis.gc!();
		}
		return process.memoryUsage().heapUsed;
	};
	const warm = await world(10, 3);
	const before = await settled();
	const measured = await world(10_000, 3);
	const per = ((await settled()) - before) / 10_000;
	console.log(`3. the heap of one open read of 3 rows, 10,000 reads: ${per.toFixed(0)} B`);
	await warm.store.close(BACKGROUND_CONTEXT);
	await measured.store.close(BACKGROUND_CONTEXT);
}

await heapPerRead();
