// Persisted jobs: `persist: { resume }` keeps each unsettled run's record and state document in the object's store.
// A run survives a crash (counted: five in a row end it `restart_limit`), a clean close (written back `stopped`, resumed
// without counting) and its object's retry; `abort` is stored and joins `run`; a state change may be `deferred`.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/28-persisted-jobs.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../../src/next/host/index.ts";
import { defineJob, type JobHandle } from "../../../src/next/jobs/index.ts";
import { openStore, type Store, sqliteBackend } from "../../../src/next/store/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// The run's state: persisted, as a persisted job's must be.
const ImportState = defineState("notes.import.state", {
	schema: obj({ done: int() }),
	version: 1,
	initial: () => ({ done: 0 }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 16,
});

const ImportJob = defineJob("notes.import", {
	version: 1,
	args: obj({ path: str() }),
	result: obj({ count: int() }),
	state: ImportState,
	// After a crash or a stop, `run` runs again: it must be idempotent (only work since the last state change repeats).
	persist: { resume: "rerun" },
});

const Notes = local("notes.store", {
	version: 1,
	params: {},
	members: { start: method(str(), str()), abort: method(str(), str()) },
});

/** How the current process's `run` behaves: hang (to be cut off) or finish. */
let behaviour: "hang" | "finish" = "hang";
let jobs: JobHandle<{ path: string }, { count: number }, { done: number }> | undefined;

const facet = defineFacet((host) => {
	host.serve(Notes, (_, self) => {
		const imports = self.job(ImportJob, {
			run: async ({ path }, ctx) => {
				console.log(`  run ${path}: from done = ${ctx.state.value.done}`);
				// Progress, deferred: published at once, stored within 100 ms (or with the next immediate change).
				await ctx.state.change(
					(draft) => {
						draft.done += 1;
					},
					ctx,
					{ persistence: { kind: "deferred", withinMs: 100 } },
				);
				if (behaviour === "hang")
					await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
				return { count: ctx.state.value.done };
			},
			finish: async (outcome) => {
				console.log(`  finish: ${outcome.kind}`, outcome.kind === "done" ? outcome.result : outcome.error.kind);
			},
		});
		jobs = imports;
		return {
			start: async (path, ctx) => (await imports.start({ path }, ctx)).id,
			abort: (id, ctx) => imports.abort(id, ctx),
		};
	});
});

/** A process: a store over the file and a host serving `Notes`. */
async function process(path: string): Promise<{ store: Store; host: Host }> {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	const host = createHost({
		store,
		onError: (error) => console.log("  onError:", error.kind),
		closeTimeout: 100,
	});
	await host.load([{ name: "@example/notes", facet }], context);
	return { store, host };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const directory = await mkdtemp(join(tmpdir(), "chord-example-28-"));
const path = join(directory, "session.sqlite");

// 1. Start a run, then crash: the store closes under the live host.
console.log("1. start, then crash");
let { store, host } = await process(path);
const id = await (await host.get(Notes, {}, context)).start("inbox", context);
await settle();
await store.close(context);

// 2. The next process counts the crash and reruns it (its state as stored: the deferred change was stored in time).
console.log("2. reopen: the run is counted and rerun");
({ store, host } = await process(path));
await settle();

// 3. A clean close writes the run back `stopped`: the next process resumes it without counting.
console.log("3. clean close, reopen: resumed, uncounted");
await host.close(context);
await store.close(context);
behaviour = "finish";
({ store, host } = await process(path));
await settle();
console.log("   unsettled runs now:", jobs?.running.value.length);

// 4. A stored abort: marked, joined.
console.log("4. abort");
behaviour = "hang";
const notes = await host.get(Notes, {}, context);
const second = await notes.start("drafts", context);
await settle();
console.log("   abort:", await notes.abort(second, context));
await settle();
console.log("   once settled:", await notes.abort(second, context), "/ the first run:", await notes.abort(id, context));

await host.close(context);
await store.close(context);
await rm(directory, { recursive: true, force: true });
