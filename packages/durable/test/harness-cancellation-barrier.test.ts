import type { Context } from "@earendil-works/chord";
import {
	createSession,
	defineTask,
	MemoryStorage,
	type Seq,
	type StorageWrite,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, flush } from "./session-support.ts";
import { aborted, deferred, eventually, openTasks } from "./task-support.ts";

/** Runs until aborted; its abort handler ends it `aborted`. */
const Dormant = defineTask<null, { phase: "work" }, null>({
	name: "test.dormant",
	version: 1,
	initial: () => ({ phase: "work" }),
	phases: {
		work: async (_task, runtime) => {
			await aborted(runtime.signal);
		},
	},
	abort: async (_task, runtime, abortContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
	},
});

/** Holds every commit that abort-marks `target`, while set, until released. */
class HoldMarks extends MemoryStorage {
	target: TaskId | undefined;
	readonly held = deferred();
	readonly release = deferred();
	override async commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, commitContext: Context) {
		if (
			writes.some((write) => write.type === "task" && write.value.id === this.target && write.value.abortRequested)
		) {
			this.held.resolve();
			await this.release.promise;
		}
		return super.commit(writes, adopt, commitContext);
	}
}

describe("work below a cancelled owner", () => {
	it("does not start its next phase while the cascade that marks it has not committed", async () => {
		const storage = new HoldMarks();
		const entered = deferred();
		const advance = deferred();
		let ranNext = false;
		const Child = defineTask<null, { phase: "first" } | { phase: "next" }, null>({
			name: "test.child",
			version: 1,
			initial: () => ({ phase: "first" }),
			phases: {
				first: async (_task, runtime, phaseContext) => {
					entered.resolve();
					await advance.promise;
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), phaseContext);
				},
				next: async (_task, runtime) => {
					ranNext = true;
					await aborted(runtime.signal);
				},
			},
			abort: async (_task, runtime, abortContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
		});
		const { harness } = await openTasks(storage, [Dormant, Child]);
		const root = await harness.root(context);
		const parent = await root.commit(
			(tx) => tx.createTask(Dormant, null, { ownership: { kind: "conversation" } }),
			context,
		);
		const child = await root.commit(
			(tx) => tx.createTask(Child, null, { ownership: { kind: "task", taskId: parent } }),
			context,
		);
		storage.target = child;
		try {
			harness.resume();
			await entered.promise;
			const aborting = harness.abortTask(parent, context);
			await storage.held.promise;
			// The parent's request is durable, the cascade's mark of the child is not: its phase must not advance.
			advance.resolve();
			for (let i = 0; i < 5; i++) await flush();
			expect(ranNext).toBe(false);
			storage.release.resolve();
			expect((await harness.waitForTask(child, context)).state.outcome.status).toBe("aborted");
			await aborting;
			expect(ranNext).toBe(false);
		} finally {
			advance.resolve();
			storage.release.resolve();
			await harness.close(context);
		}
	});

	it("lets a failFast request in the same pass override a restart mark", async () => {
		const storage = new MemoryStorage();
		const session = createSession(storage);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const parent = await session.commit(
			(tx) => tx.createTask(Dormant, null, { conversationId: conversation.id, ownership: { kind: "conversation" } }),
			context,
		);
		const failed = await session.commit(
			(tx) => tx.createTask(Dormant, null, { ownership: { kind: "task", taskId: parent } }),
			context,
		);
		const child = await session.commit(
			(tx) => tx.createTask(Dormant, null, { ownership: { kind: "task", taskId: parent } }),
			context,
		);
		// A restart-abandoned owner that waits failFast on a failed child and a live one.
		const owner = (await storage.task(parent, context))!;
		const failedRecord = (await storage.task(failed, context))!;
		const waiting = {
			status: "waiting",
			checkpoint: { phase: "work" },
			on: [failed, child],
			policy: "failFast",
		} as const;
		const failure = { status: "failed", error: { message: "failed" } } as const;
		await storage.commit(
			[
				{ type: "task", value: { ...owner, abortRequested: true, abortReason: "restart", state: waiting } },
				{
					type: "task",
					value: { ...failedRecord, state: { status: "terminal", outcome: failure } } as typeof failedRecord,
				},
			],
			() => {},
			context,
		);
		// The child's definition is missing: a restart mark would keep it waiting, a request orphans it.
		const { harness } = await openTasks(storage, []);
		try {
			harness.resume();
			await eventually(async () => (await harness.getTask(child, context))?.state.status === "terminal");
			expect((await harness.getTask(child, context))?.state).toMatchObject({
				outcome: { status: "orphaned", reason: "missing_task" },
			});
		} finally {
			await harness.close(context);
		}
	});

	it("upgrades restart marks down the tree when an abort is requested above them", async () => {
		const storage = new MemoryStorage();
		const session = createSession(storage);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const top = await session.commit(
			(tx) => tx.createTask(Dormant, null, { conversationId: conversation.id, ownership: { kind: "conversation" } }),
			context,
		);
		const middle = await session.commit(
			(tx) => tx.createTask(Dormant, null, { ownership: { kind: "task", taskId: top }, abandonOnRestart: true }),
			context,
		);
		const Missing = defineTask<null, { phase: "work" }, null>({ ...Dormant.definition, name: "test.missing" });
		const leaf = await session.commit(
			(tx) => tx.createTask(Missing, null, { ownership: { kind: "task", taskId: middle } }),
			context,
		);
		// Only Dormant is registered: the leaf waits for its definition under the restart cascade.
		const { harness } = await openTasks(storage, [Dormant]);
		try {
			harness.resume();
			await eventually(async () => (await harness.getTask(leaf, context))?.abortReason === "restart");
			await eventually(async () => {
				const inspected = (await harness.inspect(context)).tasks.find((task) => task.record.id === leaf);
				return inspected?.state.kind === "blocked";
			});
			expect((await harness.getTask(leaf, context))?.state.status).not.toBe("terminal");
			// A request on the top task reaches the leaf two levels down, which is then orphaned.
			await harness.abortTask(top, context);
			for (const [id, status] of [
				[leaf, "orphaned"],
				[middle, "aborted"],
				[top, "aborted"],
			] as const) {
				expect((await harness.waitForTask(id, context)).state.outcome.status).toBe(status);
			}
		} finally {
			await harness.close(context);
		}
	});

	it("marks a flagged task that holds its outcome, aborting its owned work, and keeps the outcome", async () => {
		const storage = new MemoryStorage();
		const session = createSession(storage);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const holder = await session.commit(
			(tx) =>
				tx.createTask(Dormant, null, {
					conversationId: conversation.id,
					ownership: { kind: "conversation" },
					abandonOnRestart: true,
				}),
			context,
		);
		const child = await session.commit(
			(tx) => tx.createTask(Dormant, null, { ownership: { kind: "task", taskId: holder } }),
			context,
		);
		const record = (await storage.task(holder, context))!;
		const completing = { status: "completing", outcome: { status: "completed", result: null } } as const;
		await storage.commit(
			[{ type: "task", value: { ...record, state: completing } as typeof record }],
			() => {},
			context,
		);
		const { harness } = await openTasks(storage, [Dormant]);
		try {
			harness.resume();
			expect((await harness.waitForTask(child, context)).state.outcome.status).toBe("aborted");
			const settled = await harness.waitForTask(holder, context);
			expect(settled).toMatchObject({ abortReason: "restart", state: { outcome: { status: "completed" } } });
		} finally {
			await harness.close(context);
		}
	});
});
