// Close, reopen, and continue where a task stopped.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/13-recovery.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness } from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// Everything a task needs to continue is in storage, so a new Harness over the
// same storage picks up where the last one stopped. This example keeps its
// storage in a SQLite file so it survives closing.
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
const databasePath = join(directory, "session.sqlite");

let reachedTick = (_n: number): void => {};
const Ticker = defineTask<{ to: number }, { phase: "tick"; n: number }, string>({
	name: "example.ticker",
	version: 1,
	initial: () => ({ phase: "tick", n: 1 }),
	phases: {
		tick: async (task, runtime, taskContext) => {
			const n = task.state.checkpoint.n;
			// Save the intent before the effect. A memo keeps the first value
			// written under its name, so if the process dies after printing but
			// before the next checkpoint is saved, the rerun sees the memo and
			// does not print the same tick twice.
			if ((await runtime.memo(`printed-${n}`, taskContext)) === undefined) {
				await runtime.memo(`printed-${n}`, true, taskContext);
				console.log(`tick ${n}`);
			}
			reachedTick(n);
			// Save the outcome: the next tick, or the final result.
			await runtime.commit(
				() =>
					n === task.input.to
						? { status: "terminal", outcome: { status: "completed", result: `counted to ${n}` } }
						: { status: "running", checkpoint: { phase: "tick", n: n + 1 } },
				taskContext,
			);
			// Wait a little between ticks. Closing the Harness cancels this wait;
			// the checkpoint saved above is where the next Harness continues.
			await runtime.sleep(Date.now() + 50, taskContext);
		},
	},
	abort: async (_task, runtime, taskContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});
const registry = createRegistry();
registry.tasks.add(Ticker);
const open = async () =>
	Harness.open(await openNodeSqliteStorage(databasePath), { models: createModels(), registry }, context);

// First run: start counting to 5, and close the Harness right after tick 2 is
// printed, before its next checkpoint is saved. That is the same situation as
// a crash between the effect and saving its outcome.
const firstRun = await open();
const tickerId = await (await firstRun.root(context)).commit((tx) => tx.createTask(Ticker, { to: 5 }), context);
const tickTwo = new Promise<void>((resolve) => {
	reachedTick = (n) => {
		if (n === 2) resolve();
	};
});
firstRun.resume();
await tickTwo;
await firstRun.close(context);
reachedTick = () => {};

// Read the saved record through a Harness that never resumes, so nothing runs.
const reader = await open();
const saved = (await reader.getTask(tickerId, context))!;
await reader.close(context);
console.log("closed; saved checkpoint:", saved.state, "memos:", saved.memos);

// Second run: nothing to restart by hand. Waiting for the unfinished task
// enables scheduling and continues it. Tick 2 runs again because its outcome
// was never saved, but its memo says it was already printed.
const secondRun = await open();
const counted = await secondRun.waitForTask(tickerId, context);
console.log("after reopen:", counted.state.outcome);
await secondRun.close(context);
await rm(directory, { recursive: true, force: true });
