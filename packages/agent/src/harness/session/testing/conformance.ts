import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import type { AgentMessage } from "../../../types.ts";
import type {
	CustomEntry,
	Entry,
	MessageEntry,
	NewRecord,
	OperationStartedRecord,
	SessionErrorCode,
	SessionRepo,
} from "../types.ts";
import type { SessionBackendConformanceCase, SessionBackendFixtureFactory } from "./types.ts";

function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
}

function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function operationStarted(
	id: string,
	{ lane, kind }: { lane: string; kind: OperationStartedRecord["intent"]["kind"] },
): NewRecord<OperationStartedRecord> {
	let intent: OperationStartedRecord["intent"];
	switch (kind) {
		case "run":
			intent = { kind, originalPrompt: [], initialMessages: [] };
			break;
		case "compaction":
			intent = { kind, resultEntryId: `${id}-result` };
			break;
		case "navigation":
			intent = { kind, targetId: null, summarize: false };
			break;
	}
	return { type: "operation_started", id, lane, sourceLeafId: null, intent };
}

async function entryIds(entries: Promise<Entry[]>): Promise<string[]> {
	return (await entries).map((entry) => entry.id);
}

async function rejectsWithCode(operation: Promise<unknown>, code: SessionErrorCode): Promise<void> {
	await rejects(
		operation,
		(error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code,
		`Expected SessionError with code ${code}`,
	);
}

type ConformanceTest = (repository: SessionRepo) => Promise<void>;

function createCase(
	factory: SessionBackendFixtureFactory,
	group: string,
	name: string,
	test: ConformanceTest,
): SessionBackendConformanceCase {
	return {
		group,
		name,
		async run() {
			await using fixture = await factory();
			await test(fixture.repository);
		},
	};
}

/** Creates the session backend conformance cases. Each case creates and disposes its own fixture. */
export function createSessionBackendConformance(
	factory: SessionBackendFixtureFactory,
): readonly SessionBackendConformanceCase[] {
	return [
		createCase(
			factory,
			"entries and lanes",
			"assigns parents and one sequence across every mutation",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const root = await session.appendEntry<MessageEntry>(
					{ type: "message", id: "root", message: createUserMessage("root") },
					"main",
				);
				await session.createLane("thread", root.id);
				const child = await session.appendEntry<CustomEntry>(
					{ type: "custom", id: "child", customType: "note", data: { value: 1 } },
					"thread",
				);
				const record = await session.appendRecord(operationStarted("run", { lane: "thread", kind: "run" }));
				await session.setName("Example");
				await session.setLabel(root.id, "checkpoint");
				await session.moveLane("main", child.id);

				deepStrictEqual({ parentId: root.parentId, seq: root.seq }, { parentId: null, seq: 1 });
				deepStrictEqual({ parentId: child.parentId, seq: child.seq }, { parentId: "root", seq: 3 });
				strictEqual(record.seq, 4);
				for (const timestamp of [root.timestamp, child.timestamp, record.timestamp]) {
					ok(
						Number.isSafeInteger(timestamp) && timestamp >= 0,
						"storage-assigned timestamps must be Unix milliseconds",
					);
				}
				deepStrictEqual(
					(await session.getLog()).map((item) => [item.kind, item.seq]),
					[
						["entry", 1],
						["lane", 2],
						["entry", 3],
						["record", 4],
						["fact", 5],
						["fact", 6],
						["lane", 7],
					],
				);
				deepStrictEqual(await session.getLanes(), [
					{ lane: "main", leafId: "child" },
					{ lane: "thread", leafId: "child" },
				]);
			},
		),

		createCase(
			factory,
			"records and log",
			"commits records and lane moves as separate mutations",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const root = await session.appendEntry<MessageEntry>(
					{ type: "message", id: "root", message: createUserMessage("root") },
					"main",
				);
				const finished = await session.appendRecord({
					type: "operation_finished",
					id: "finish",
					lane: "main",
					runId: "run",
					outcome: "completed",
				});

				strictEqual(finished.seq, 2);
				deepStrictEqual(await session.getLanes(), [{ lane: "main", leafId: "root" }]);
				await session.moveLane("main", null);
				deepStrictEqual(await session.getLanes(), [{ lane: "main", leafId: null }]);
				deepStrictEqual(await session.getLog(), [
					{ kind: "entry", seq: 1, entry: root },
					{ kind: "record", seq: 2, record: finished },
					{ kind: "lane", seq: 3, lane: "main", leafId: null },
				]);

				await rejectsWithCode(session.moveLane("main", "missing"), "not_found");
				strictEqual((await session.findRecords()).length, 1);
				deepStrictEqual(
					(await session.getLog()).map((item) => item.seq),
					[1, 2, 3],
				);
			},
		),

		createCase(factory, "entries and lanes", "rejects duplicate ids without changing state", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "shared", message: createUserMessage("root") },
				"main",
			);
			await rejectsWithCode(
				session.appendRecord(operationStarted("shared", { lane: "main", kind: "run" })),
				"already_exists",
			);
			await session.appendRecord(operationStarted("run", { lane: "main", kind: "run" }));
			await rejectsWithCode(
				session.appendEntry<CustomEntry>({ type: "custom", id: "run", customType: "note" }, "main"),
				"already_exists",
			);
			deepStrictEqual(
				(await session.getLog()).map((item) => item.seq),
				[1, 2],
			);
		}),

		createCase(factory, "entries and lanes", "isolates lanes while sharing the tree", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "root", message: createUserMessage("root") },
				"main",
			);
			await session.createLane("thread", "root");
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "main-child", message: createUserMessage("main") },
				"main",
			);
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "thread-child", message: createUserMessage("thread") },
				"thread",
			);

			deepStrictEqual(await session.getLanes(), [
				{ lane: "main", leafId: "main-child" },
				{ lane: "thread", leafId: "thread-child" },
			]);
			deepStrictEqual(await entryIds(session.findEntriesOnBranch({ start: "main-child", order: "oldestFirst" })), [
				"root",
				"main-child",
			]);
			deepStrictEqual(await entryIds(session.findEntriesOnBranch({ start: "thread-child", order: "oldestFirst" })), [
				"root",
				"thread-child",
			]);
		}),

		createCase(factory, "queries and facts", "rejects invalid queries before empty reads", async (repository) => {
			const session = await repository.create({ id: "invalid-queries" });
			await session.createLane("thread", null);
			const thread = session.view("thread");

			await rejectsWithCode(session.findEntries({ limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findEntry({ limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findEntriesOnBranch({ limit: 0 }), "invalid_query");
			await rejectsWithCode(thread.findEntriesOnBranch({ cursor: { afterSeq: -1 } }), "invalid_query");
			await rejectsWithCode(thread.findEntryOnBranch({ limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findRecords({ limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findRecords({ operationKind: "run" }), "invalid_query");
			await rejectsWithCode(session.findRecords({ type: "step_attempt", operationKind: "run" }), "invalid_query");
			await rejectsWithCode(session.findOpenOperations("main", { limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findOpenOperations("main", { limit: -1 }), "invalid_query");
			await rejectsWithCode(session.getLog({ afterSeq: -1 }), "invalid_query");
		}),

		createCase(
			factory,
			"queries and facts",
			"supports bounded filtered and cursor-based queries",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				await session.appendEntry<MessageEntry>(
					{ type: "message", id: "root", message: createUserMessage("root") },
					"main",
				);
				await session.appendEntry<CustomEntry>(
					{ type: "custom", id: "old-note", customType: "note", data: 1 },
					"main",
				);
				await session.appendEntry(
					{ type: "compaction", id: "compact", summary: "summary", retainedTail: [], tokensBefore: 10 },
					"main",
				);
				await session.appendEntry<CustomEntry>(
					{ type: "custom", id: "new-note", customType: "note", data: 2 },
					"main",
				);
				await session.appendEntry<MessageEntry>(
					{ type: "message", id: "tail", message: createAssistantMessage("tail") },
					"main",
				);

				deepStrictEqual(await entryIds(session.findEntries()), ["tail", "new-note", "compact", "old-note", "root"]);
				deepStrictEqual(
					await entryIds(session.findEntries({ order: "oldestFirst", cursor: { afterSeq: 2 }, limit: 2 })),
					["compact", "new-note"],
				);
				deepStrictEqual(await entryIds(session.findEntries({ customType: "note" })), ["new-note", "old-note"]);
				deepStrictEqual(
					await entryIds(session.findEntriesOnBranch({ start: "tail", customType: "note", limit: 1 })),
					["new-note"],
				);
				deepStrictEqual(
					await entryIds(
						session.findEntriesOnBranch({ start: "tail", stopAtType: "compaction", type: "message" }),
					),
					["tail"],
				);
				deepStrictEqual(
					await entryIds(session.findEntriesOnBranch({ start: "tail", stopAtId: "tail", type: "custom" })),
					[],
				);
				deepStrictEqual(
					await entryIds(
						session.findEntriesOnBranch({ start: "tail", stopAtType: "custom", order: "oldestFirst" }),
					),
					["root", "old-note"],
				);
				await rejectsWithCode(session.findEntries({ limit: 0 }), "invalid_query");
				await rejectsWithCode(session.findEntriesOnBranch({ start: "missing" }), "not_found");
			},
		),

		createCase(
			factory,
			"records and log",
			"keeps lane names permanent with their recovery records",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				await session.createLane("thread", null);
				await session.appendRecord(operationStarted("old-run", { lane: "thread", kind: "run" }));
				await session.appendRecord({
					type: "queue_enqueued",
					id: "old-next-run",
					lane: "thread",
					queue: "nextRun",
					target: { type: "message", id: "queued-message", message: createUserMessage("queued") },
				});

				deepStrictEqual(
					(await session.findRecords({ lane: "thread" })).map((record) => record.id),
					["old-next-run", "old-run"],
				);
				deepStrictEqual(
					(await session.getLog()).flatMap((item) => (item.kind === "record" ? [item.record.id] : [])),
					["old-run", "old-next-run"],
				);
				await rejectsWithCode(session.createLane("thread", null), "already_exists");
			},
		),

		createCase(
			factory,
			"records and log",
			"persists queue cancellation without consuming its target",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const enqueued = await session.appendRecord({
					type: "queue_enqueued",
					id: "enqueue",
					lane: "main",
					queue: "nextRun",
					target: { type: "message", id: "queued-message", message: createUserMessage("queued") },
				});
				const cancelled = await session.appendRecord({
					type: "queue_cancelled",
					id: "cancel",
					lane: "main",
					entryId: "queued-message",
				});
				deepStrictEqual({ seq: cancelled.seq, entryId: cancelled.entryId }, { seq: 2, entryId: "queued-message" });
				strictEqual("runId" in cancelled, false);
				strictEqual(await session.getEntry("queued-message"), undefined);
				const cancellations = await session.findRecords({ type: "queue_cancelled" });
				strictEqual(cancellations[0]?.entryId, "queued-message");
				deepStrictEqual(cancellations, [cancelled]);
				deepStrictEqual(await session.getLog(), [
					{ kind: "record", seq: enqueued.seq, record: enqueued },
					{ kind: "record", seq: cancelled.seq, record: cancelled },
				]);
			},
		),

		createCase(
			factory,
			"records and log",
			"filters records by lane type run sequence and order",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				await session.appendRecord(operationStarted("run-1", { lane: "main", kind: "run" }));
				await session.appendRecord({
					type: "step_attempt",
					id: "attempt-1",
					lane: "main",
					runId: "run-1",
					step: "assistant",
					attempt: 1,
					resultEntryId: "assistant-1",
				});
				await session.createLane("thread", null);
				await session.appendRecord(operationStarted("run-2", { lane: "thread", kind: "run" }));
				await session.appendRecord({
					type: "step_attempt",
					id: "attempt-2",
					lane: "thread",
					runId: "run-2",
					step: "assistant",
					attempt: 1,
					resultEntryId: "assistant-2",
				});

				deepStrictEqual(
					(await session.findRecords({ lane: "thread" })).map((record) => record.id),
					["attempt-2", "run-2"],
				);
				deepStrictEqual(
					(await session.findRecords({ type: "step_attempt", order: "oldestFirst" })).map((record) => record.id),
					["attempt-1", "attempt-2"],
				);
				deepStrictEqual(
					(await session.findRecords({ runId: "run-1", afterSeq: 1 })).map((record) => record.id),
					["attempt-1"],
				);
				deepStrictEqual(
					(await session.findRecords({ limit: 1 })).map((record) => record.id),
					["attempt-2"],
				);
			},
		),

		createCase(factory, "records and log", "filters operation starts by operation kind", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.appendRecord(operationStarted("run-old", { lane: "main", kind: "run" }));
			await session.appendRecord({
				type: "operation_finished",
				id: "run-old-finished",
				lane: "main",
				runId: "run-old",
				outcome: "completed",
			});
			await session.appendRecord(operationStarted("compaction", { lane: "main", kind: "compaction" }));
			await session.appendRecord({
				type: "operation_finished",
				id: "compaction-finished",
				lane: "main",
				runId: "compaction",
				outcome: "completed",
			});
			await session.appendRecord(operationStarted("navigation", { lane: "main", kind: "navigation" }));
			await session.appendRecord({
				type: "operation_finished",
				id: "navigation-finished",
				lane: "main",
				runId: "navigation",
				outcome: "completed",
			});
			await session.appendRecord(operationStarted("run-new", { lane: "main", kind: "run" }));

			deepStrictEqual(
				(
					await session.findRecords({
						type: "operation_started",
						operationKind: "run",
						order: "oldestFirst",
					})
				).map((record) => record.id),
				["run-old", "run-new"],
			);
			deepStrictEqual(
				(
					await session.findRecords({
						type: "operation_started",
						operationKind: "compaction",
					})
				).map((record) => record.id),
				["compaction"],
			);
			deepStrictEqual(
				(
					await session.findRecords({
						type: "operation_started",
						operationKind: "navigation",
					})
				).map((record) => record.id),
				["navigation"],
			);
			deepStrictEqual(
				(
					await session.findRecords({
						type: "operation_started",
						operationKind: "run",
						limit: 1,
					})
				).map((record) => record.id),
				["run-new"],
			);
		}),

		createCase(factory, "records and log", "tracks and enforces one open operation per lane", async (repository) => {
			const session = await repository.create({ id: "session" });
			deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), []);

			const first = await session.appendRecord(operationStarted("first", { lane: "main", kind: "run" }));
			deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), [first]);
			await rejectsWithCode(
				session.appendRecord(operationStarted("second", { lane: "main", kind: "run" })),
				"storage",
			);
			deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), [first]);

			await session.appendRecord({
				type: "operation_finished",
				id: "finish-first",
				lane: "main",
				runId: first.id,
				outcome: "completed",
			});
			deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), []);
		}),

		createCase(
			factory,
			"records and log",
			"does not let an earlier finish close a later start",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				await session.appendRecord({
					type: "operation_finished",
					id: "finish-before-start",
					lane: "main",
					runId: "run",
					outcome: "completed",
				});
				const started = await session.appendRecord(operationStarted("run", { lane: "main", kind: "run" }));
				deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), [started]);
			},
		),

		createCase(factory, "records and log", "scopes open operations by lane and limit", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.createLane("thread", null);
			const mainRun = await session.appendRecord(operationStarted("main-run", { lane: "main", kind: "run" }));
			const threadNavigation = await session.appendRecord(
				operationStarted("thread-navigation", { lane: "thread", kind: "navigation" }),
			);

			deepStrictEqual(await session.findOpenOperations("main"), [mainRun]);
			deepStrictEqual(await session.findOpenOperations("main", { limit: 1 }), [mainRun]);
			deepStrictEqual(await session.findOpenOperations("thread", { limit: 2 }), [threadNavigation]);
		}),

		createCase(
			factory,
			"validation and immutability",
			"returns immutable open-operation records",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const committed = await session.appendRecord(operationStarted("run", { lane: "main", kind: "run" }));
				const [read] = await session.findOpenOperations("main");
				if (read?.intent.kind !== "run") throw new Error("Expected an open run operation");
				read.intent.originalPrompt.push(createUserMessage("mutated"));

				deepStrictEqual(await session.findOpenOperations("main"), [committed]);
			},
		),

		createCase(
			factory,
			"queries and facts",
			"keeps latest-value facts and computes ledger statistics across lanes",
			async (repository) => {
				const session = await repository.create({ id: "session" });
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
				await session.appendEntry<MessageEntry>(
					{ type: "message", id: "user", message: createUserMessage("question") },
					"main",
				);
				await session.appendEntry<MessageEntry>({ type: "message", id: "assistant", message: assistant }, "main");
				await session.appendRecord({
					type: "usage",
					id: "assistant-usage",
					lane: "main",
					cause: "assistant",
					runId: "run",
					entryId: "assistant",
					attempt: 1,
					stopReason: "stop",
					usage: assistant.usage,
				});
				await session.appendRecord({
					type: "usage",
					id: "deferred-usage",
					lane: "main",
					cause: "deferred_fetch",
					runId: "run",
					entryId: "deferred-result",
					attempt: 1,
					stopReason: "deferred",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
				await session.createLane("thread", "assistant");
				await session.appendRecord({
					type: "usage",
					id: "correction",
					lane: "thread",
					cause: "adjustment",
					details: { reason: "provider correction" },
					usage: {
						input: -2,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: -2,
						cost: { input: -0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: -0.5 },
					},
				});
				await session.setName("First");
				await session.setName("Second");
				await session.setLabel("user", "keep");
				await session.setLabel("user", undefined);
				await rejectsWithCode(session.setLabel("missing", "checkpoint"), "not_found");

				strictEqual(await session.getName(), "Second");
				strictEqual(await session.getLabel("user"), undefined);
				const usageRecords = await session.findRecords({ type: "usage", order: "oldestFirst" });
				deepStrictEqual(
					usageRecords.map((record) => record.cause),
					["assistant", "deferred_fetch", "adjustment"],
				);
				const deferredUsage = usageRecords.find((record) => record.cause === "deferred_fetch");
				if (deferredUsage?.cause !== "deferred_fetch") throw new Error("Expected deferred usage record");
				strictEqual(deferredUsage.stopReason, "deferred");
				deepStrictEqual(await session.getStats(), {
					messageCount: 2,
					cachedTokens: 3,
					uncachedTokens: 10,
					totalTokens: 18,
					costTotal: 9.5,
				});
			},
		),

		createCase(factory, "queries and facts", "clears session names durably", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.setName("Temporary");
			await session.setName(undefined);

			strictEqual(await session.getName(), undefined);
			deepStrictEqual(await session.getLog(), [
				{ kind: "fact", seq: 1, fact: "name", name: "Temporary" },
				{ kind: "fact", seq: 2, fact: "name", name: undefined },
			]);

			const metadata = await session.getMetadata();
			const reopened = await repository.open(metadata);
			strictEqual(await reopened.getName(), undefined);
			deepStrictEqual(await reopened.getLog(), [
				{ kind: "fact", seq: 1, fact: "name", name: "Temporary" },
				{ kind: "fact", seq: 2, fact: "name", name: undefined },
			]);

			const fork = await repository.fork(metadata, { id: "fork" });
			strictEqual(await fork.getName(), undefined);
		}),

		createCase(factory, "validation and immutability", "returns immutable copies from reads", async (repository) => {
			const session = await repository.create({ id: "immutable" });
			const metadata = await session.getMetadata();
			const data = { nested: { value: 1 } };
			await session.appendEntry<CustomEntry>({ type: "custom", id: "custom", customType: "note", data }, "main");
			data.nested.value = 50;
			const read = await session.getEntry("custom");
			if (read?.type !== "custom") throw new Error("Expected custom entry");
			(read.data as { nested: { value: number } }).nested.value = 99;
			const readMetadata = await session.getMetadata();
			readMetadata.id = "changed";
			const log = await session.getLog();
			if (log[0]?.kind !== "entry" || log[0].entry.type !== "custom") throw new Error("Expected entry log");
			(log[0].entry.data as { nested: { value: number } }).nested.value = 100;

			deepStrictEqual(await session.getMetadata(), metadata);
			deepStrictEqual(await session.getEntry("custom"), {
				type: "custom",
				id: "custom",
				customType: "note",
				data: { nested: { value: 1 } },
				parentId: null,
				seq: 1,
				timestamp: read.timestamp,
			});
		}),

		createCase(factory, "entries and lanes", "validates lane lifecycle and targets", async (repository) => {
			const session = await repository.create({ id: "session" });
			await rejectsWithCode(session.createLane("main", null), "already_exists");
			await rejectsWithCode(session.createLane("thread", "missing"), "not_found");
			await rejectsWithCode(session.moveLane("missing", null), "invalid_lane");
		}),

		createCase(factory, "entries and lanes", "binds lane views without caching leaves", async (repository) => {
			const session = await repository.create({ id: "session" });
			const root = await session.appendMessage(createUserMessage("root"));
			await session.createLane("thread", root);
			const thread = session.view("thread");
			const [mainChild, threadChild] = await Promise.all([
				session.appendMessage(createUserMessage("main")),
				thread.appendMessage(createUserMessage("thread")),
			]);

			strictEqual(await session.getLeafId(), mainChild);
			strictEqual(await thread.getLeafId(), threadChild);
			deepStrictEqual(await entryIds(session.findEntriesOnBranch({ order: "oldestFirst" })), [root, mainChild]);
			deepStrictEqual(await entryIds(thread.findEntriesOnBranch({ order: "oldestFirst" })), [root, threadChild]);
			const empty = await repository.create({ id: "empty" });
			deepStrictEqual(await empty.findEntriesOnBranch(), []);
		}),

		createCase(
			factory,
			"entries and lanes",
			"appends provisioned entries with their existing ids",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const entry = await session.appendEntry<CustomEntry>(
					{ type: "custom", id: "provisioned", customType: "note", data: { value: 1 } },
					"main",
				);

				strictEqual(entry.customType, "note");
				deepStrictEqual(
					{ id: entry.id, parentId: entry.parentId, seq: entry.seq },
					{ id: "provisioned", parentId: null, seq: 1 },
				);
				strictEqual(await session.getLeafId(), "provisioned");
			},
		),

		createCase(factory, "entries and lanes", "persists tool-result termination decisions", async (repository) => {
			const session = await repository.create({ id: "session" });
			const entry = await session.appendEntry<MessageEntry>(
				{
					type: "message",
					id: "tool-result",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "example",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: 1,
					},
					terminate: true,
				},
				"main",
			);

			strictEqual(entry.terminate, true);
			const stored = await session.getEntry(entry.id);
			if (stored?.type !== "message") throw new Error("Expected message entry");
			strictEqual(stored.terminate, true);
			deepStrictEqual(await session.findEntries(), [entry]);
			deepStrictEqual(await session.getLog(), [{ kind: "entry", seq: entry.seq, entry }]);
		}),

		createCase(
			factory,
			"validation and immutability",
			"rejects non-JSON entries before storage mutation",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const cyclic: { self?: unknown } = {};
				cyclic.self = cyclic;

				for (const data of [
					{ value: undefined },
					[undefined],
					{ value: 1n },
					{ value: Number.NaN },
					{ value: new Map() },
					cyclic,
				]) {
					await rejectsWithCode(session.appendCustomEntry("invalid", data), "invalid_payload");
				}

				strictEqual(await session.getLeafId(), null);
				deepStrictEqual(await session.findEntries(), []);
				deepStrictEqual(await session.getLog(), []);
				const validId = await session.appendCustomEntry("valid", { value: 1 });
				strictEqual((await session.getEntry(validId))?.seq, 1);
			},
		),

		createCase(
			factory,
			"validation and immutability",
			"rejects non-JSON records before storage mutation",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				for (const [id, value] of [
					["undefined-record", undefined],
					["bigint-record", 1n],
				] as const) {
					await rejectsWithCode(
						session.appendRecord({
							type: "tool_started",
							id,
							lane: "main",
							runId: "run",
							assistantEntryId: "assistant",
							toolIndex: 0,
							toolCallId: "call",
							toolName: "example",
							effectiveArgs: { value },
							resultEntryId: "result",
							replay: "never",
						}),
						"invalid_payload",
					);
				}

				deepStrictEqual(await session.findRecords(), []);
				deepStrictEqual(await session.getLog(), []);
				strictEqual(
					(await session.appendRecord(operationStarted("valid-record", { lane: "main", kind: "run" }))).seq,
					1,
				);
			},
		),

		createCase(factory, "entries and lanes", "linearizes concurrent writes across two lanes", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "root", message: createUserMessage("root") },
				"main",
			);
			await session.createLane("thread", "root");
			const completionOrder: string[] = [];
			const writes = [
				session.appendEntry<CustomEntry>({ type: "custom", id: "main-1", customType: "note" }, "main"),
				session.appendEntry<CustomEntry>({ type: "custom", id: "thread-1", customType: "note" }, "thread"),
				session.appendEntry<CustomEntry>({ type: "custom", id: "main-2", customType: "note" }, "main"),
				session.appendEntry<CustomEntry>({ type: "custom", id: "thread-2", customType: "note" }, "thread"),
			].map((write) =>
				write.then((entry) => {
					completionOrder.push(entry.id);
					return entry;
				}),
			);
			const entries = await Promise.all(writes);
			const commitOrder = [...entries].sort((left, right) => left.seq - right.seq).map((entry) => entry.id);

			strictEqual(new Set(entries.map((entry) => entry.seq)).size, entries.length);
			deepStrictEqual(completionOrder, commitOrder);
			const concurrentIds = new Set(entries.map((entry) => entry.id));
			deepStrictEqual(
				(await session.getLog()).flatMap((item) =>
					item.kind === "entry" && concurrentIds.has(item.entry.id) ? [item.entry.id] : [],
				),
				commitOrder,
			);
			const sequences = (await session.getLog()).map((item) => item.seq);
			deepStrictEqual(
				sequences,
				[...sequences].sort((left, right) => left - right),
			);
		}),

		createCase(factory, "repository and forks", "creates lists and opens sessions", async (repository) => {
			const session = await repository.create({ id: "one" });
			const entryId = await session.appendMessage(createUserMessage("persisted"));
			const metadata = await session.getMetadata();

			const listed = await repository.list();
			strictEqual(listed.length, 1);
			strictEqual(listed[0]?.id, metadata.id);
			strictEqual(listed[0]?.createdAt, metadata.createdAt);
			strictEqual(listed[0]?.parentSessionId, metadata.parentSessionId);
			deepStrictEqual(await entryIds((await repository.open(metadata)).findEntries()), [entryId]);
			await rejectsWithCode(repository.create({ id: "one" }), "already_exists");
		}),

		createCase(factory, "repository and forks", "deletes sessions idempotently", async (repository) => {
			const session = await repository.create({ id: "one" });
			const metadata = await session.getMetadata();

			await repository.delete(metadata);
			await rejectsWithCode(repository.open(metadata), "not_found");
			await repository.delete(metadata);
		}),

		createCase(
			factory,
			"repository and forks",
			"forks one branch with selected facts and no records",
			async (repository) => {
				const source = await repository.create({ id: "source" });
				const root = await source.appendMessage(createUserMessage("root"));
				const shared = await source.appendMessage(createAssistantMessage("shared"));
				await source.createLane("thread", shared);
				const threadChild = await source.view("thread").appendMessage(createUserMessage("thread"));
				const mainChild = await source.appendMessage(createUserMessage("main"));
				await source.setName("Source");
				await source.setLabel(shared, "copied");
				await source.setLabel(threadChild, "excluded");
				await source.appendRecord(operationStarted("run", { lane: "main", kind: "run" }));
				await source.appendRecord({
					type: "usage",
					id: "source-usage",
					lane: "main",
					cause: "adjustment",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 3,
						cacheWrite: 2,
						totalTokens: 20,
						cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
					},
				});

				const fork = await repository.fork(await source.getMetadata(), {
					scope: "branch",
					entryId: mainChild,
					position: "at",
					id: "branch-fork",
				});

				deepStrictEqual(await entryIds(fork.findEntries({ order: "oldestFirst" })), [root, shared, mainChild]);
				deepStrictEqual(await fork.getLanes(), [{ lane: "main", leafId: mainChild }]);
				strictEqual(await fork.getName(), "Source");
				strictEqual(await fork.getLabel(shared), "copied");
				strictEqual(await fork.getLabel(threadChild), undefined);
				deepStrictEqual(await fork.findRecords(), []);
				deepStrictEqual(await fork.getStats(), {
					messageCount: 3,
					cachedTokens: 0,
					uncachedTokens: 0,
					totalTokens: 0,
					costTotal: 0,
				});
				await fork.appendMessage(createUserMessage("after fork"));
				strictEqual((await fork.getStats()).messageCount, 4);
				const metadata = await fork.getMetadata();
				deepStrictEqual(
					{ id: metadata.id, parentSessionId: metadata.parentSessionId },
					{ id: "branch-fork", parentSessionId: "source" },
				);
			},
		),

		createCase(factory, "repository and forks", "forks a complete tree with lanes and facts", async (repository) => {
			const source = await repository.create({ id: "source" });
			const root = await source.appendMessage(createUserMessage("root"));
			await source.createLane("thread", root);
			const mainChild = await source.appendMessage(createUserMessage("main"));
			const threadChild = await source.view("thread").appendMessage(createUserMessage("thread"));
			await source.setLabel(threadChild, "thread-tip");

			const fork = await repository.fork(await source.getMetadata(), { scope: "tree", id: "tree-fork" });
			deepStrictEqual(await entryIds(fork.findEntries({ order: "oldestFirst" })), [root, mainChild, threadChild]);
			deepStrictEqual(await fork.getLanes(), [
				{ lane: "main", leafId: mainChild },
				{ lane: "thread", leafId: threadChild },
			]);
			strictEqual(await fork.getLabel(threadChild), "thread-tip");
			strictEqual((await fork.getStats()).messageCount, 3);
			deepStrictEqual(
				(await fork.getLog()).filter((item) => item.kind === "lane"),
				[
					{ kind: "lane", seq: 4, lane: "main", leafId: mainChild },
					{ kind: "lane", seq: 5, lane: "thread", leafId: threadChild },
				],
			);
		}),

		createCase(
			factory,
			"repository and forks",
			"forks before an entry without modifying the source",
			async (repository) => {
				const source = await repository.create({ id: "source" });
				const root = await source.appendMessage(createUserMessage("root"));
				const tail = await source.appendMessage(createUserMessage("tail"));
				const fork = await repository.fork(await source.getMetadata(), { entryId: tail, id: "fork" });

				deepStrictEqual(await entryIds(fork.findEntries({ order: "oldestFirst" })), [root]);
				strictEqual(await fork.getLeafId(), root);
				strictEqual(await source.getLeafId(), tail);
				const beforeDefaultTarget = await repository.fork(await source.getMetadata(), {
					position: "before",
					id: "before-default-target",
				});
				deepStrictEqual(await entryIds(beforeDefaultTarget.findEntries({ order: "oldestFirst" })), [root]);
				strictEqual(await beforeDefaultTarget.getLeafId(), root);

				const atDefaultTarget = await repository.fork(await source.getMetadata(), {
					position: "at",
					id: "at-default-target",
				});
				deepStrictEqual(await entryIds(atDefaultTarget.findEntries({ order: "oldestFirst" })), [root, tail]);
				strictEqual(await atDefaultTarget.getLeafId(), tail);
				await rejectsWithCode(
					repository.fork(await source.getMetadata(), { entryId: "missing" }),
					"invalid_fork_target",
				);
			},
		),

		createCase(factory, "repository and forks", "validates the default fork target", async (repository) => {
			const source = await repository.create({ id: "source-with-custom-leaf" });
			await source.appendCustomEntry("not-a-message");

			await rejectsWithCode(repository.fork(await source.getMetadata(), { id: "fork" }), "invalid_fork_target");
		}),
	];
}
