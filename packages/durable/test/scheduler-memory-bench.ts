/**
 * Scheduler memory benchmark. Under one live parent task, N subagent cycles run and end: a tool task owned by the
 * parent, a conversation owned by the tool task, and a task in that conversation. Reports the scheduler's ownership
 * index sizes and the bytes live objects retain (from heap snapshots) once all cycles ended, then the storage reads a later message into an old subagent
 * conversation costs. On SQLite, so durable history stays out of the heap.
 *
 *   node --conditions=source --experimental-strip-types test/scheduler-memory-bench.ts [cycles...]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { SCHEDULER_INDEX_SIZES } from "../src/harness/harness.ts";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	type TaskId,
} from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { retainedBytes } from "./heap-retained.ts";

const waiting = new Map<string, () => void>();
/** Holds until released by name, then completes. */
const Hold = defineTask<{ name: string }, { phase: "hold" }, null>({
	name: "bench.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			await new Promise<void>((resolve) => waiting.set(task.input.name, resolve));
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

async function release(name: string): Promise<void> {
	while (!waiting.has(name)) await new Promise((resolve) => setTimeout(resolve, 0));
	waiting.get(name)!();
	waiting.delete(name);
}

type Sizes = Record<"live" | "settled" | "edges" | "below" | "roots" | "unloaded" | "dropQueue", number>;

async function run(cycles: number) {
	const directory = mkdtempSync(join(tmpdir(), "pi-durable-memory-bench-"));
	try {
		const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
		const reads = { count: 0 };
		const task = storage.task.bind(storage);
		const conversation = storage.conversation.bind(storage);
		storage.task = (id, readContext) => {
			reads.count++;
			return task(id, readContext);
		};
		storage.conversation = (id, readContext) => {
			reads.count++;
			return conversation(id, readContext);
		};
		const registry = createRegistry();
		registry.install(defineExtension({ name: "bench", tasks: [Hold] }));
		const harness = await Harness.open(storage, { models: createModels(), registry }, context);
		const root = await harness.root(context);
		harness.resume();
		const parent = await root.commit(
			(tx) => tx.createTask(Hold, { name: "parent" }, { ownership: { kind: "conversation" } }),
			context,
		);
		const heapBefore = await retainedBytes();
		let first: ConversationId | undefined;
		const started = performance.now();
		for (let n = 0; n < cycles; n++) {
			const { tool, inner, child } = await root.commit(async (tx) => {
				const tool = await tx.createTask(
					Hold,
					{ name: `tool${n}` },
					{ ownership: { kind: "task", taskId: parent } },
				);
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: tool } });
				const inner = await tx.createTask(
					Hold,
					{ name: `inner${n}` },
					{ ownership: { kind: "conversation" }, conversationId: child.id },
				);
				return { tool, inner, child: child.id };
			}, context);
			await release(`inner${n}`);
			await release(`tool${n}`);
			await harness.waitForTask(inner as TaskId, context);
			await harness.waitForTask(tool as TaskId, context);
			first ??= child;
		}
		const ms = Math.round(performance.now() - started);
		const heapAfter = await retainedBytes();
		const sizes = (harness as unknown as Record<symbol, Sizes>)[SCHEDULER_INDEX_SIZES]!;
		// A later message into an old subagent conversation: a task created there, run, and ended.
		const readsBefore = reads.count;
		const old = (await harness.conversation(first!, context))!;
		const late = await old.commit(
			(tx) => tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await release("late");
		await harness.waitForTask(late, context);
		const lateReads = reads.count - readsBefore;
		await release("parent");
		await harness.waitForTask(parent, context);
		await harness.close(context);
		return { ms, sizes, heap: heapAfter - heapBefore, lateReads };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const cycles = process.argv.slice(2).map(Number);
console.log("cycles | ms     | settled | edges  | below | heap growth             | reads for a later message");
for (const n of cycles.length > 0 ? cycles : [1000, 10000]) {
	const { ms, sizes, heap, lateReads } = await run(n);
	console.log(
		`${String(n).padEnd(6)} | ${String(ms).padEnd(6)} | ${String(sizes.settled).padEnd(7)} | ${String(sizes.edges).padEnd(6)} | ${String(sizes.below).padEnd(5)} | ${`${(heap / 1024 / 1024).toFixed(1)} MiB, ${Math.round(heap / n)} B/cycle`.padEnd(23)} | ${lateReads}`,
	);
	// The scheduler's ownership indexes must not grow with ended history; the heap still includes the Session's caches.
	if (sizes.settled > 0 || sizes.edges > 1)
		throw new Error(`ownership indexes grew with history: ${JSON.stringify(sizes)}`);
}
