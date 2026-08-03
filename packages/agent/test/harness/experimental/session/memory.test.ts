import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CustomEntry,
	type Entry,
	InMemorySessionRepository,
	InMemorySessionStorage,
	type NewRecord,
	Session,
	type SessionMetadata,
} from "../../../../src/experimental.ts";
import { createAssistantMessage, createUserMessage } from "../../session-test-utils.ts";

afterEach(() => {
	vi.useRealTimers();
});

function createStorage(id = "session"): InMemorySessionStorage {
	return new InMemorySessionStorage({ id, createdAt: 1 });
}

function operationStarted(id: string, lane = "main"): NewRecord {
	return {
		type: "operation_started",
		id,
		lane,
		sourceLeafId: null,
		intent: { kind: "run", initialMessages: [] },
	};
}

async function entryIds(entries: Promise<Entry[]>): Promise<string[]> {
	return (await entries).map((entry) => entry.id);
}

describe("InMemorySessionStorage", () => {
	it("assigns parents, timestamps, and one sequence across every mutation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const storage = createStorage();
		const root = await storage.appendEntry(
			{ type: "message", id: "root", message: createUserMessage("root") },
			"main",
		);
		await storage.createLane("thread", root.id);
		vi.setSystemTime(2000);
		const child = await storage.appendEntry(
			{ type: "custom", id: "child", customType: "note", data: { value: 1 } },
			"thread",
		);
		const record = await storage.appendRecord(operationStarted("run", "thread"));
		await storage.setName("Example");
		await storage.setLabel(root.id, "checkpoint");
		await storage.moveLane("main", child.id);
		await storage.deleteLane("thread");

		expect(root).toMatchObject({ parentId: null, seq: 1, timestamp: 1000 });
		expect(child).toMatchObject({ parentId: "root", seq: 3, timestamp: 2000 });
		expect(record).toMatchObject({ seq: 4, timestamp: 2000 });
		expect((await storage.getLog()).map((item) => [item.kind, item.seq])).toEqual([
			["entry", 1],
			["lane", 2],
			["entry", 3],
			["record", 4],
			["fact", 5],
			["fact", 6],
			["lane", 7],
			["lane", 8],
		]);
		expect(await storage.getLanes()).toEqual([{ lane: "main", leafId: "child" }]);
	});

	it("atomically appends a record and moves a lane", async () => {
		const storage = createStorage();
		await storage.appendEntry({ type: "message", id: "root", message: createUserMessage("root") }, "main");
		const finished = await storage.appendRecord(
			{
				type: "operation_finished",
				id: "finish",
				lane: "main",
				runId: "run",
				outcome: "completed",
			},
			{ moveLane: { lane: "main", to: null } },
		);

		expect(finished.seq).toBe(2);
		expect(await storage.getLanes()).toEqual([{ lane: "main", leafId: null }]);
		expect(await storage.getLog()).toEqual([
			expect.objectContaining({ kind: "entry", seq: 1 }),
			expect.objectContaining({ kind: "record", seq: 2, moveLane: { lane: "main", to: null } }),
		]);

		await expect(
			storage.appendRecord(operationStarted("bad"), { moveLane: { lane: "main", to: "missing" } }),
		).rejects.toMatchObject({ code: "not_found" });
		expect(await storage.findRecords()).toHaveLength(1);
		expect((await storage.getLog()).map((item) => item.seq)).toEqual([1, 2]);
	});

	it("rejects duplicate ids across entries and records without changing state", async () => {
		const storage = createStorage();
		await storage.appendEntry({ type: "message", id: "shared", message: createUserMessage("root") }, "main");
		await expect(storage.appendRecord(operationStarted("shared"))).rejects.toMatchObject({ code: "already_exists" });
		await storage.appendRecord(operationStarted("run"));
		await expect(
			storage.appendEntry({ type: "custom", id: "run", customType: "note" }, "main"),
		).rejects.toMatchObject({ code: "already_exists" });

		expect((await storage.getLog()).map((item) => item.seq)).toEqual([1, 2]);
	});

	it("isolates lanes while sharing the tree", async () => {
		const storage = createStorage();
		await storage.appendEntry({ type: "message", id: "root", message: createUserMessage("root") }, "main");
		await storage.createLane("thread", "root");
		await storage.appendEntry({ type: "message", id: "main-child", message: createUserMessage("main") }, "main");
		await storage.appendEntry(
			{ type: "message", id: "thread-child", message: createUserMessage("thread") },
			"thread",
		);

		expect(await storage.getLanes()).toEqual([
			{ lane: "main", leafId: "main-child" },
			{ lane: "thread", leafId: "thread-child" },
		]);
		expect(await entryIds(storage.findEntriesOnBranch({ start: "main-child", order: "oldestFirst" }))).toEqual([
			"root",
			"main-child",
		]);
		expect(await entryIds(storage.findEntriesOnBranch({ start: "thread-child", order: "oldestFirst" }))).toEqual([
			"root",
			"thread-child",
		]);
	});

	it("supports bounded, filtered, cursor-based tree and branch queries", async () => {
		const storage = createStorage();
		await storage.appendEntry({ type: "message", id: "root", message: createUserMessage("root") }, "main");
		await storage.appendEntry({ type: "custom", id: "old-note", customType: "note", data: 1 }, "main");
		await storage.appendEntry(
			{ type: "compaction", id: "compact", summary: "summary", retainedTail: [], tokensBefore: 10 },
			"main",
		);
		await storage.appendEntry({ type: "custom", id: "new-note", customType: "note", data: 2 }, "main");
		await storage.appendEntry({ type: "message", id: "tail", message: createAssistantMessage("tail") }, "main");

		expect(await entryIds(storage.findEntries())).toEqual(["tail", "new-note", "compact", "old-note", "root"]);
		expect(await entryIds(storage.findEntries({ order: "oldestFirst", cursor: { afterSeq: 2 }, limit: 2 }))).toEqual([
			"compact",
			"new-note",
		]);
		expect(await entryIds(storage.findEntries({ customType: "note" }))).toEqual(["new-note", "old-note"]);
		expect(await entryIds(storage.findEntriesOnBranch({ start: "tail", customType: "note", limit: 1 }))).toEqual([
			"new-note",
		]);
		expect(
			await entryIds(storage.findEntriesOnBranch({ start: "tail", stopAtType: "compaction", type: "message" })),
		).toEqual(["tail"]);
		expect(await entryIds(storage.findEntriesOnBranch({ start: "tail", stopAtId: "tail", type: "custom" }))).toEqual(
			[],
		);
		expect(
			await entryIds(
				storage.findEntriesOnBranch({
					start: "tail",
					stopAtType: "custom",
					order: "oldestFirst",
				}),
			),
		).toEqual(["root", "old-note"]);
		await expect(storage.findEntries({ limit: 0 })).rejects.toMatchObject({ code: "invalid_query" });
		await expect(storage.findEntriesOnBranch({ start: "missing" })).rejects.toMatchObject({ code: "not_found" });
	});

	it("retires a deleted lane's records before its name is reused", async () => {
		const storage = createStorage();
		await storage.createLane("thread", null);
		await storage.appendRecord(operationStarted("old-run", "thread"));
		await storage.appendRecord({
			type: "queue_enqueued",
			id: "old-next-run",
			lane: "thread",
			queue: "nextRun",
			target: { type: "message", id: "queued-message", message: createUserMessage("queued") },
		});

		await storage.deleteLane("thread");
		expect(await storage.findRecords({ lane: "thread" })).toEqual([]);
		expect((await storage.getLog()).flatMap((item) => (item.kind === "record" ? [item.record.id] : []))).toEqual([
			"old-run",
			"old-next-run",
		]);

		await storage.createLane("thread", null);
		await storage.appendRecord(operationStarted("new-run", "thread"));
		expect((await storage.findRecords({ lane: "thread" })).map((record) => record.id)).toEqual(["new-run"]);
	});

	it("filters operation records by lane, type, run, sequence, and order", async () => {
		const storage = createStorage();
		await storage.appendRecord(operationStarted("run-1"));
		await storage.appendRecord({
			type: "task_attempt",
			id: "attempt-1",
			lane: "main",
			runId: "run-1",
			task: "step",
			attempt: 1,
		});
		await storage.createLane("thread", null);
		await storage.appendRecord(operationStarted("run-2", "thread"));
		await storage.appendRecord({
			type: "task_attempt",
			id: "attempt-2",
			lane: "thread",
			runId: "run-2",
			task: "step",
			attempt: 1,
		});

		expect((await storage.findRecords({ lane: "thread" })).map((record) => record.id)).toEqual([
			"attempt-2",
			"run-2",
		]);
		expect(
			(await storage.findRecords({ type: "task_attempt", order: "oldestFirst" })).map((record) => record.id),
		).toEqual(["attempt-1", "attempt-2"]);
		expect((await storage.findRecords({ runId: "run-1", afterSeq: 1 })).map((record) => record.id)).toEqual([
			"attempt-1",
		]);
		expect((await storage.findRecords({ limit: 1 })).map((record) => record.id)).toEqual(["attempt-2"]);
	});

	it("keeps latest-value facts and computes session statistics", async () => {
		const storage = createStorage();
		const assistant = createAssistantMessage("answer");
		if (assistant.role !== "assistant") throw new Error("Expected assistant message");
		assistant.usage = {
			input: 10,
			output: 5,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 20,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		await storage.appendEntry({ type: "message", id: "user", message: createUserMessage("question") }, "main");
		await storage.appendEntry({ type: "message", id: "assistant", message: assistant }, "main");
		await storage.setName("First");
		await storage.setName("Second");
		await storage.setLabel("user", "keep");
		await storage.setLabel("user", undefined);

		expect(await storage.getName()).toBe("Second");
		expect(await storage.getLabel("user")).toBeUndefined();
		expect(await storage.getStats()).toEqual({
			messageCount: 2,
			cachedTokens: 3,
			uncachedTokens: 12,
			totalTokens: 20,
			costTotal: 10,
		});
	});

	it("returns immutable copies from every read", async () => {
		const metadata: SessionMetadata = { id: "immutable", createdAt: 1 };
		const storage = new InMemorySessionStorage(metadata);
		await storage.appendEntry(
			{ type: "custom", id: "custom", customType: "note", data: { nested: { value: 1 } } },
			"main",
		);
		const read = await storage.getEntry("custom");
		if (read?.type !== "custom") throw new Error("Expected custom entry");
		(read.data as { nested: { value: number } }).nested.value = 99;
		const readMetadata = await storage.getMetadata();
		readMetadata.id = "changed";
		const log = await storage.getLog();
		if (log[0]?.kind !== "entry" || log[0].entry.type !== "custom") throw new Error("Expected entry log");
		(log[0].entry.data as { nested: { value: number } }).nested.value = 100;

		expect(await storage.getMetadata()).toEqual(metadata);
		expect(await storage.getEntry("custom")).toMatchObject({ data: { nested: { value: 1 } } });
	});

	it("validates lane lifecycle and targets", async () => {
		const storage = createStorage();
		await expect(storage.createLane("main", null)).rejects.toMatchObject({ code: "already_exists" });
		await expect(storage.createLane("thread", "missing")).rejects.toMatchObject({ code: "not_found" });
		await expect(storage.moveLane("missing", null)).rejects.toMatchObject({ code: "invalid_lane" });
		await expect(storage.deleteLane("main")).rejects.toMatchObject({ code: "invalid_lane" });
	});
});

describe("Session", () => {
	it("binds reads and writes to lane views without cached leaves", async () => {
		const session = new Session(createStorage());
		const root = await session.appendMessage(createUserMessage("root"));
		await session.createLane("thread", root);
		const thread = session.view("thread");
		const [mainChild, threadChild] = await Promise.all([
			session.appendMessage(createUserMessage("main")),
			thread.appendMessage(createUserMessage("thread")),
		]);

		expect(await session.getLeafId()).toBe(mainChild);
		expect(await thread.getLeafId()).toBe(threadChild);
		expect(await entryIds(session.findEntriesOnBranch({ order: "oldestFirst" }))).toEqual([root, mainChild]);
		expect(await entryIds(thread.findEntriesOnBranch({ order: "oldestFirst" }))).toEqual([root, threadChild]);
		expect(await new Session(createStorage("empty")).findEntriesOnBranch()).toEqual([]);
	});

	it("uses one injectable id generator across lane views", async () => {
		let nextId = 0;
		const session = new Session(createStorage(), { idGenerator: { next: () => `generated-${++nextId}` } });
		const mainId = await session.appendMessage(createUserMessage("main"));
		await session.createLane("thread", mainId);
		const threadId = await session.view("thread").appendCustomEntry("note");

		expect(mainId).toBe("generated-1");
		expect(threadId).toBe("generated-2");
	});

	it("appends provisioned entries with their existing ids", async () => {
		const session = new Session(createStorage());
		const entry = await session.appendEntry<CustomEntry>(
			{ type: "custom", id: "provisioned", customType: "note", data: { value: 1 } },
			"main",
		);

		expect(entry.customType).toBe("note");
		expect(entry).toMatchObject({ id: "provisioned", parentId: null, seq: 1 });
		expect(await session.getLeafId()).toBe("provisioned");
	});

	it("serializes concurrent lane writes through storage-owned parents", async () => {
		const session = new Session(createStorage());
		const ids = await Promise.all([
			session.appendMessage(createUserMessage("one")),
			session.appendMessage(createUserMessage("two")),
			session.appendMessage(createUserMessage("three")),
		]);

		expect(await entryIds(session.findEntriesOnBranch({ order: "oldestFirst" }))).toEqual(ids);
	});
});

describe("InMemorySessionRepository", () => {
	it("creates and opens sessions", async () => {
		const repository = new InMemorySessionRepository();
		const session = await repository.create({ id: "one" });
		const entryId = await session.appendMessage(createUserMessage("persisted"));
		const metadata = await session.getMetadata();

		expect(await entryIds((await repository.open(metadata)).findEntries())).toEqual([entryId]);
		await expect(repository.create({ id: "one" })).rejects.toMatchObject({ code: "already_exists" });
	});

	it("deletes sessions idempotently", async () => {
		const repository = new InMemorySessionRepository();
		const session = await repository.create({ id: "one" });
		const metadata = await session.getMetadata();

		await expect(repository.delete(metadata)).resolves.toBeUndefined();
		await expect(repository.open(metadata)).rejects.toMatchObject({ code: "not_found" });
		await expect(repository.delete(metadata)).resolves.toBeUndefined();
	});

	it("forks one branch with selected facts and no operation records", async () => {
		const repository = new InMemorySessionRepository();
		const source = await repository.create({ id: "source" });
		const root = await source.appendMessage(createUserMessage("root"));
		const shared = await source.appendMessage(createAssistantMessage("shared"));
		await source.createLane("thread", shared);
		const threadChild = await source.view("thread").appendMessage(createUserMessage("thread"));
		const mainChild = await source.appendMessage(createUserMessage("main"));
		await source.setName("Source");
		await source.setLabel(shared, "copied");
		await source.setLabel(threadChild, "excluded");
		await source.appendRecord(operationStarted("run"));

		const fork = await repository.fork(await source.getMetadata(), {
			scope: "branch",
			entryId: mainChild,
			position: "at",
			id: "branch-fork",
		});

		expect(await entryIds(fork.findEntries({ order: "oldestFirst" }))).toEqual([root, shared, mainChild]);
		expect(await fork.getLanes()).toEqual([{ lane: "main", leafId: mainChild }]);
		expect(await fork.getName()).toBe("Source");
		expect(await fork.getLabel(shared)).toBe("copied");
		expect(await fork.getLabel(threadChild)).toBeUndefined();
		expect(await fork.findRecords()).toEqual([]);
		expect(await fork.getMetadata()).toMatchObject({ id: "branch-fork", parentSessionId: "source" });
	});

	it("forks a complete tree with all lane pointers and facts", async () => {
		const repository = new InMemorySessionRepository();
		const source = await repository.create({ id: "source" });
		const root = await source.appendMessage(createUserMessage("root"));
		await source.createLane("thread", root);
		const mainChild = await source.appendMessage(createUserMessage("main"));
		const threadChild = await source.view("thread").appendMessage(createUserMessage("thread"));
		await source.setLabel(threadChild, "thread-tip");

		const fork = await repository.fork(await source.getMetadata(), { scope: "tree", id: "tree-fork" });

		expect(await entryIds(fork.findEntries({ order: "oldestFirst" }))).toEqual([root, mainChild, threadChild]);
		expect(await fork.getLanes()).toEqual([
			{ lane: "main", leafId: mainChild },
			{ lane: "thread", leafId: threadChild },
		]);
		expect(await fork.getLabel(threadChild)).toBe("thread-tip");
	});

	it("forks before an entry without modifying the source", async () => {
		const repository = new InMemorySessionRepository();
		const source = await repository.create({ id: "source" });
		const root = await source.appendMessage(createUserMessage("root"));
		const tail = await source.appendMessage(createUserMessage("tail"));

		const fork = await repository.fork(await source.getMetadata(), { entryId: tail, id: "fork" });

		expect(await entryIds(fork.findEntries({ order: "oldestFirst" }))).toEqual([root]);
		expect(await fork.getLeafId()).toBe(root);
		expect(await source.getLeafId()).toBe(tail);
		await expect(repository.fork(await source.getMetadata(), { entryId: "missing" })).rejects.toMatchObject({
			code: "invalid_fork_target",
		});
	});
});
