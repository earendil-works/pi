import type { JsonValue } from "@earendil-works/chord";
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { CachedStorage } from "../src/session/cached-storage.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import type { ConversationId, StorageWrite, TaskId, TaskRecord } from "../src/types.ts";
import { context } from "./session-support.ts";

function task(id: number, status: "pending" | "running" = "pending"): TaskRecord<JsonValue, JsonValue, JsonValue> {
	return {
		id: idFromNumber<TaskId<JsonValue>>(id),
		conversationId: idFromNumber<ConversationId>(1),
		kind: "test.task",
		version: 1,
		input: null,
		background: false,
		abortRequested: false,
		state: { status, checkpoint: { phase: "run" } },
	};
}

class CountingStorage extends MemoryStorage {
	taskReads = 0;
	override task(...args: Parameters<MemoryStorage["task"]>) {
		this.taskReads++;
		return super.task(...args);
	}
}

/** Stores `writes` as one batch, then publishes it, as the Session does. */
async function commit(storage: CachedStorage, writes: StorageWrite[]): Promise<void> {
	await commitWrites(storage, writes, context);
	storage.published(writes);
}

describe("cached storage", () => {
	it("serves a written record without a read and follows later writes", async () => {
		const backend = new CountingStorage();
		const storage = new CachedStorage(backend);
		await commit(storage, [{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } }]);
		await commit(storage, [{ type: "task", value: task(2) }]);
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("pending");
		await commit(storage, [{ type: "task", value: task(2, "running") }]);
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("running");
		expect(backend.taskReads).toBe(0);
	});

	it("keeps a read only when no commit overlapped it", async () => {
		const backend = new CountingStorage();
		await commitWrites(
			backend,
			[
				{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } },
				{ type: "task", value: task(2) },
			],
			context,
		);
		const storage = new CachedStorage(backend);
		const overlapped = storage.task(idFromNumber<TaskId>(2), context);
		const written = commit(storage, [{ type: "task", value: task(2, "running") }]);
		await Promise.all([overlapped, written]);
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("running");
		await storage.task(idFromNumber<TaskId>(2), context);
		expect(backend.taskReads).toBe(1);
	});

	it("keeps a bounded number of ended tasks, and every live one until it ends", async () => {
		const backend = new CountingStorage();
		const storage = new CachedStorage(backend);
		await commit(storage, [{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } }]);
		for (let id = 2; id < 600; id++) await commit(storage, [{ type: "task", value: task(id) }]);
		// More live tasks than the ended table holds: each one's next change finds it without a read.
		expect(storage.sizes).toMatchObject({ tasks: 0, liveTasks: 598 });
		for (let id = 2; id < 600; id++) await storage.task(idFromNumber<TaskId>(id), context);
		expect(backend.taskReads).toBe(0);
		for (let id = 2; id < 600; id++) {
			const ended = { ...task(id), state: { status: "terminal", outcome: { status: "completed", result: null } } };
			await commit(storage, [{ type: "task", value: ended as TaskRecord<JsonValue, JsonValue, JsonValue> }]);
		}
		expect(storage.sizes).toMatchObject({ tasks: 256, liveTasks: 0 });
	});

	it("applies a batch stored with commit when it is published, not at its receipt", async () => {
		const backend = new CountingStorage();
		const storage = new CachedStorage(backend);
		await commit(storage, [
			{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } },
			{ type: "task", value: task(2) },
		]);
		const batch: StorageWrite[] = [{ type: "task", value: task(2, "running") }];
		const receipts: number[] = [];
		expect(await storage.commit([batch], (index) => receipts.push(index), context)).toEqual({ stored: 1 });
		expect(receipts).toEqual([0]);
		// Stored, not yet published: the cache still shows what was published.
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("pending");
		storage.published(batch);
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("running");
		expect(backend.taskReads).toBe(0);
	});

	it("drops a read a publication of its record overlapped, and keeps versions only for reads in flight", async () => {
		const backend = new CountingStorage();
		await commitWrites(
			backend,
			[
				{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } },
				{ type: "task", value: task(2) },
				{ type: "task", value: task(3) },
			],
			context,
		);
		const storage = new CachedStorage(backend);
		const overlapped = storage.task(idFromNumber<TaskId>(2), context);
		const untouched = storage.task(idFromNumber<TaskId>(3), context);
		expect(storage.readsInFlight).toBe(2);
		// A publication of another record does not drop the read of task 3.
		storage.published([{ type: "task", value: task(2, "running") }]);
		await Promise.all([overlapped, untouched]);
		expect(storage.readsInFlight).toBe(0);
		expect((await storage.task(idFromNumber<TaskId>(2), context))?.state.status).toBe("running");
		expect((await storage.task(idFromNumber<TaskId>(3), context))?.state.status).toBe("pending");
		expect(backend.taskReads).toBe(2);
	});

	it("keeps the ended tasks a task waits on until it moved on from its wait", async () => {
		const backend = new CountingStorage();
		const storage = new CachedStorage(backend);
		await commit(storage, [{ type: "conversation", value: { id: idFromNumber<ConversationId>(1) } }]);
		const ended = (id: number) =>
			({
				...task(id),
				state: { status: "terminal", outcome: { status: "completed", result: id } },
			}) as TaskRecord<JsonValue, JsonValue, JsonValue>;
		const waiting = (state: TaskRecord<JsonValue, JsonValue, JsonValue>["state"]) =>
			({ ...task(2), state }) as TaskRecord<JsonValue, JsonValue, JsonValue>;
		const on = [3, 4].map((id) => idFromNumber<TaskId>(id));
		await commit(storage, [
			{
				type: "task",
				value: waiting({ status: "waiting", checkpoint: { phase: "read" }, on, policy: "allSettled" }),
			},
		]);
		await commit(storage, [
			{ type: "task", value: ended(3) },
			{ type: "task", value: ended(4) },
		]);
		// A burst of other ended tasks fills the bounded table.
		for (let id = 10; id < 300; id++) await commit(storage, [{ type: "task", value: ended(id) }]);
		expect(storage.sizes).toMatchObject({ awaited: 2, waits: 1 });
		// Resumed: still held for the phase that reads the outcomes.
		await commit(storage, [{ type: "task", value: waiting({ status: "running", checkpoint: { phase: "read" } }) }]);
		for (const id of on) expect((await storage.task(id, context))?.state.status).toBe("terminal");
		expect(backend.taskReads).toBe(0);
		expect(storage.sizes).toMatchObject({ awaited: 2, waits: 1 });
		// Its next change ends the hold: the records go back to the bounded table, and no wait is left.
		await commit(storage, [{ type: "task", value: waiting({ status: "running", checkpoint: { phase: "next" } }) }]);
		expect(storage.sizes).toMatchObject({ awaited: 0, waits: 0, tasks: 256 });
		// A wait that ends with its task leaves nothing either.
		await commit(storage, [
			{
				type: "task",
				value: waiting({ status: "waiting", checkpoint: { phase: "read" }, on, policy: "allSettled" }),
			},
		]);
		expect(storage.sizes).toMatchObject({ awaited: 2, waits: 1 });
		await commit(storage, [{ type: "task", value: ended(2) }]);
		expect(storage.sizes).toMatchObject({ awaited: 0, waits: 0 });
	});

	it("keeps the written record itself, frozen: no copy", async () => {
		const storage = new CachedStorage(new MemoryStorage());
		const conversation = { id: idFromNumber<ConversationId>(1) };
		const record = task(2);
		storage.published([
			{ type: "conversation", value: conversation },
			{ type: "task", value: record },
		]);
		expect(await storage.task(idFromNumber<TaskId>(2), context)).toBe(record);
		expect(await storage.conversation(idFromNumber<ConversationId>(1), context)).toBe(conversation);
		expect(Object.isFrozen(record.state)).toBe(true);
	});
});
