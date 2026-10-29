// Benchmark of persisted jobs (slice 6b §4, §5): a run's start (its record and state created, resolved after the
// commit) and a state change inside `run` (immediate, and deferred), for a persisted job on a SQLite file against the
// same job in memory. Median and p95 per operation over several bursts. A disk commit is not held to the in-memory
// number: the persisted columns show what a run's records cost on the store.
// Run by hand from packages/chord (not in CI):
//   node --conditions=source --experimental-strip-types --expose-gc test/next/bench/jobs.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { defineJob, type JobHandle, type RunState } from "../../../src/next/jobs/index.ts";
import { openStore, sqliteBackend } from "../../../src/next/store/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";

const OPERATIONS = 500;
const RUNS = 7;

type Progress = { done: number };

const InMemoryProgress = defineState("bench.progress", {
	schema: obj({ done: int() }),
	version: 1,
	initial: () => ({ done: 0 }),
});

const PersistedProgress = defineState("bench.progress", {
	schema: obj({ done: int() }),
	version: 1,
	initial: () => ({ done: 0 }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

const InMemoryImport = defineJob("bench.import", {
	version: 1,
	args: obj({ path: str() }),
	result: obj({ count: int() }),
	state: InMemoryProgress,
});

const PersistedImport = defineJob("bench.import", {
	version: 1,
	args: obj({ path: str() }),
	result: obj({ count: int() }),
	state: PersistedProgress,
	persist: { resume: "rerun" },
});

const Worker = local("bench.worker", { version: 1, params: {}, members: {} });

/** Where a run's `run` parks: its state, and the gate that ends it. */
type Parked = { readonly state: RunState<Progress>; readonly end: () => void };

/** A host serving `Worker` with the job (persisted on a fresh SQLite file, or in memory), its runs parked. */
async function served(persisted: boolean) {
	const directory = await mkdtemp(join(tmpdir(), "chord-bench-jobs-"));
	const store = persisted
		? await openStore(sqliteBackend(await openNodeSqliteDatabase(join(directory, "store.sqlite"))), context)
		: undefined;
	const parked: Parked[] = [];
	const waiting: ((parked: Parked) => void)[] = [];
	let jobs: JobHandle<{ path: string }, { count: number }, Progress> | undefined;
	const host = createHost({ store, onError: () => {} });
	const facet = defineFacet((h) =>
		h.serve(Worker, (_, self) => {
			jobs = self.job(persisted ? PersistedImport : InMemoryImport, {
				run: (_args, ctx) =>
					new Promise((resolve) => {
						const run = { state: ctx.state, end: () => resolve({ count: ctx.state.value.done }) };
						const next = waiting.shift();
						if (next === undefined) parked.push(run);
						else next(run);
					}),
			});
			return {};
		}),
	);
	await host.load([{ name: "@bench/jobs", facet }], context);
	const reference = await host.get(Worker, {}, context);
	return {
		jobs: jobs!,
		/** The parked `run` of the next run invoked. */
		next: () => new Promise<Parked>((resolve) => waiting.push(resolve)),
		close: async () => {
			reference.release();
			await host.close(context);
			await store?.close(context);
			await rm(directory, { recursive: true, force: true });
		},
	};
}

/** Per-operation times (ms) of `RUNS` bursts, after one warm-up burst; `burst` does `OPERATIONS` timed operations. */
async function bursts(
	persisted: boolean,
	burst: (
		worker: Awaited<ReturnType<typeof served>>,
		time: (operation: () => Promise<unknown>) => Promise<void>,
	) => Promise<void>,
) {
	const times: number[] = [];
	for (let run = -1; run < RUNS; run++) {
		const worker = await served(persisted);
		await burst(worker, async (operation) => {
			const before = performance.now();
			await operation();
			if (run >= 0) times.push(performance.now() - before);
		});
		await worker.close();
	}
	times.sort((a, b) => a - b);
	return { median: times[Math.floor(times.length / 2)]!, p95: times[Math.floor(times.length * 0.95)]! };
}

/** Starts: each run's start resolved (record and state committed), its `run` parked, all ended after the burst. */
function starts(persisted: boolean) {
	return bursts(persisted, async ({ jobs, next }, time) => {
		const parked: Parked[] = [];
		for (let index = 0; index < OPERATIONS; index++) {
			const invoked = next();
			await time(() => jobs.start({ path: `p${index}` }, context));
			parked.push(await invoked);
		}
		for (const run of parked) run.end();
	});
}

/** State changes: `OPERATIONS` changes of one run's state, immediate or deferred (stored by the outcome). */
function changes(persisted: boolean, deferred: boolean) {
	const options = deferred ? { persistence: { kind: "deferred", withinMs: Infinity } as const } : undefined;
	return bursts(persisted, async ({ jobs, next }, time) => {
		const invoked = next();
		await jobs.start({ path: "p" }, context);
		const { state, end } = await invoked;
		for (let index = 0; index < OPERATIONS; index++) {
			await time(() =>
				state.change(
					(draft) => {
						draft.done = index + 1;
					},
					context,
					options,
				),
			);
		}
		end();
	});
}

function format({ median, p95 }: { readonly median: number; readonly p95: number }): string {
	return `median ${(median * 1000).toFixed(1)} µs, p95 ${(p95 * 1000).toFixed(1)} µs`;
}

console.log(`start, ${RUNS} bursts of ${OPERATIONS}:`);
console.log(`  in memory:  ${format(await starts(false))}`);
console.log(`  persisted:  ${format(await starts(true))}`);
console.log(`state change, ${RUNS} bursts of ${OPERATIONS}:`);
console.log(`  in memory:            ${format(await changes(false, false))}`);
console.log(`  persisted, immediate: ${format(await changes(true, false))}`);
console.log(`  persisted, deferred:  ${format(await changes(true, true))}`);
