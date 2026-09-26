import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import { idFromNumber } from "../ids.ts";
import {
	type ConversationId,
	type DocumentCreate,
	type DocumentId,
	type EntryId,
	type EntryRecord,
	type JsonObject,
	ROOT_CONVERSATION_ID,
	type Storage,
	type StorageWrite,
	type SubmissionId,
	type SubmissionRecord,
	type TaskId,
	type TaskRecord,
} from "../types.ts";
import type { StorageConformanceAssertions, StorageConformanceCase, StorageConformanceOptions } from "./types.ts";

const context = BACKGROUND_CONTEXT;
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

async function createRoot(storage: Storage): Promise<ConversationId> {
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
	return ROOT_CONVERSATION_ID;
}

function pendingTask(id: TaskId<JsonValue>, conversationId: ConversationId, phase = "ready") {
	return {
		id,
		conversationId,
		kind: "test.task",
		version: 1,
		input: { value: id },
		state: { status: "pending", checkpoint: { phase } },
		after: [],
		background: false,
		abortRequested: false,
	} satisfies StoredTask;
}

function entry(
	id: EntryId,
	conversationId: ConversationId,
	kind = "message",
	extra: Partial<EntryRecord> = {},
): EntryRecord {
	return { id, conversationId, kind, ...extra };
}

type ConformanceTest = (storage: Storage) => Promise<void>;

type AssertionResult = {
	toBe(expected: unknown): void;
	toBeDefined(): void;
	toBeGreaterThan(expected: number): void;
	toBeUndefined(): void;
	toEqual(expected: unknown): void;
	toHaveLength(expected: number): void;
	toMatchObject(expected: unknown): void;
	readonly rejects: { toThrow(messageIncludes: string): Promise<void> };
	readonly resolves: { toBe(expected: unknown): Promise<void> };
};

function assertionFacade(assertions: StorageConformanceAssertions) {
	return (actual: unknown): AssertionResult => ({
		toBe: (expected) => assertions.strictEqual(actual, expected),
		toBeDefined: () => assertions.ok(actual !== undefined, "Expected value to be defined"),
		toBeGreaterThan: (expected) => assertions.greaterThan(actual as number, expected),
		toBeUndefined: () => assertions.strictEqual(actual, undefined),
		toEqual: (expected) => assertions.deepEqual(actual, expected),
		toHaveLength: (expected) => assertions.strictEqual((actual as { readonly length: unknown }).length, expected),
		toMatchObject: (expected) => assertions.partialDeepEqual(actual, expected),
		rejects: {
			toThrow: (messageIncludes) => assertions.rejects(Promise.resolve(actual), messageIncludes),
		},
		resolves: {
			toBe: async (expected) => assertions.strictEqual(await Promise.resolve(actual), expected),
		},
	});
}

function createCase(options: StorageConformanceOptions, name: string, test: ConformanceTest): StorageConformanceCase {
	return { name, run: () => options.withStorage(test) };
}

/** Creates runner-independent cases. `withStorage` must call and await its callback exactly once per case. */
export function createStorageConformance(options: StorageConformanceOptions): readonly StorageConformanceCase[] {
	const expect = assertionFacade(options.assertions);
	return [
		createCase(options, "reserves ID 1 for the immutable root conversation", async (storage) => {
			expect(await storage.mintId<ConversationId>()).toBe(2);
			await expect(createRoot(storage)).resolves.toBe(ROOT_CONVERSATION_ID);
			expect(await storage.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
			await expect(
				storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context),
			).rejects.toThrow(`ID ${ROOT_CONVERSATION_ID} already belongs to conversation`);
		}),

		createCase(
			options,
			"commits mixed table writes atomically and rolls all of them back on failure",
			async (storage) => {
				const rootId = await createRoot(storage);
				const entryId = await storage.mintId<EntryId>();
				const taskId = await storage.mintId<TaskId<JsonValue>>();
				const submissionId = await storage.mintId<SubmissionId>();
				const task = pendingTask(taskId, rootId);
				const input: SubmissionRecord = {
					id: submissionId,
					conversationId: rootId,
					requestId: "request-1",
					type: "input",
					status: "placed",
					entry: entryId,
				};
				const initialSeq = await storage.commit(
					[
						{ type: "entry", value: entry(entryId, rootId, "user", { data: { text: "hello" } }) },
						{ type: "task", value: task },
						{ type: "submission", value: input },
					],
					context,
				);

				expect(await storage.entry(entryId, context)).toEqual({
					entry: entry(entryId, rootId, "user", { data: { text: "hello" } }),
					commitSeq: initialSeq,
				});
				expect(await storage.task(taskId, context)).toEqual(task);
				expect(await storage.submission(submissionId, context)).toEqual(input);

				const transientEntryId = await storage.mintId<EntryId>();
				const runningTask: StoredTask = {
					...task,
					state: { status: "running", checkpoint: { phase: "effect" } },
				};
				const doneInput: SubmissionRecord = { ...input, status: "done", answer: transientEntryId };
				await expect(
					storage.commit(
						[
							{ type: "task", value: runningTask },
							{ type: "submission", value: doneInput },
							{ type: "entry", value: entry(transientEntryId, rootId, "assistant") },
							{ type: "conversation", value: { id: rootId } },
						],
						context,
					),
				).rejects.toThrow(`ID ${rootId} already belongs to conversation`);

				expect(await storage.task(taskId, context)).toEqual(task);
				expect(await storage.submission(submissionId, context)).toEqual(input);
				expect(await storage.entry(transientEntryId, context)).toBeUndefined();
				const afterRollbackSeq = await storage.commit(
					[{ type: "entry", value: entry(await storage.mintId<EntryId>(), rootId, "after-rollback") }],
					context,
				);
				expect(afterRollbackSeq).toBeGreaterThan(initialSeq);
			},
		),

		createCase(options, "detaches retained writes and every returned record", async (storage) => {
			const rootId = await createRoot(storage);
			const entryId = await storage.mintId<EntryId>();
			const taskId = await storage.mintId<TaskId<JsonValue>>();
			const submissionId = await storage.mintId<SubmissionId>();
			const entryData = { nested: [1, 2] };
			const checkpoint = { phase: "ready", nested: { count: 1 } };
			const detail = { codes: ["initial"] };
			const storedEntry = entry(entryId, rootId, "note", { data: entryData });
			const storedTask: StoredTask = {
				...pendingTask(taskId, rootId),
				state: { status: "pending", checkpoint },
			};
			const storedInput: SubmissionRecord = {
				id: submissionId,
				conversationId: rootId,
				type: "input",
				status: "unanswered",
				reason: "failed",
				detail,
			};
			await storage.commit(
				[
					{ type: "entry", value: storedEntry },
					{ type: "task", value: storedTask },
					{ type: "submission", value: storedInput },
				],
				context,
			);

			entryData.nested.push(3);
			checkpoint.nested.count = 2;
			detail.codes.push("mutated");
			expect((await storage.entry(entryId, context))?.entry.data).toEqual({ nested: [1, 2] });
			expect((await storage.task(taskId, context))?.state).toEqual({
				status: "pending",
				checkpoint: { phase: "ready", nested: { count: 1 } },
			});
			expect((await storage.submission(submissionId, context))?.detail).toEqual({ codes: ["initial"] });

			const readEntry = (await storage.entry(entryId, context))!.entry;
			(readEntry.data as { nested: number[] }).nested.push(9);
			const readTask = (await storage.task(taskId, context))!;
			if (readTask.state.status !== "terminal") {
				(readTask.state.checkpoint as { phase: string; nested: { count: number } }).nested.count = 9;
			}
			const readInput = (await storage.submission(submissionId, context))!;
			(readInput.detail as { codes: string[] }).codes.push("read mutation");

			expect((await storage.entry(entryId, context))?.entry.data).toEqual({ nested: [1, 2] });
			expect((await storage.task(taskId, context))?.state).toEqual({
				status: "pending",
				checkpoint: { phase: "ready", nested: { count: 1 } },
			});
			expect((await storage.submission(submissionId, context))?.detail).toEqual({ codes: ["initial"] });
		}),

		createCase(options, "detaches prototype-like JSON keys without changing object prototypes", async (storage) => {
			const rootId = await createRoot(storage);
			const entryId = await storage.mintId<EntryId>();
			const data = JSON.parse(
				'{"__proto__":{"polluted":false},"constructor":{"label":"stored"},"toString":"value"}',
			) as Record<string, JsonValue>;
			await storage.commit([{ type: "entry", value: entry(entryId, rootId, "note", { data }) }], context);

			(Reflect.get(data, "__proto__") as Record<string, JsonValue>).polluted = true;
			(Reflect.get(data, "constructor") as Record<string, JsonValue>).label = "mutated";
			const firstRead = (await storage.entry(entryId, context))!.entry.data as Record<string, JsonValue>;
			expect(Object.getPrototypeOf(firstRead)).toBe(Object.prototype);
			expect(Object.hasOwn(firstRead, "__proto__")).toBe(true);
			expect(Reflect.get(firstRead, "__proto__")).toEqual({ polluted: false });
			expect(Reflect.get(firstRead, "constructor")).toEqual({ label: "stored" });
			expect(Reflect.get(firstRead, "toString")).toBe("value");
			expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

			(Reflect.get(firstRead, "__proto__") as Record<string, JsonValue>).polluted = true;
			const secondRead = (await storage.entry(entryId, context))!.entry.data as Record<string, JsonValue>;
			expect(Reflect.get(secondRead, "__proto__")).toEqual({ polluted: false });
			expect(Reflect.get(secondRead, "constructor")).toEqual({ label: "stored" });
			expect(Reflect.get(secondRead, "toString")).toBe("value");
		}),

		createCase(options, "indexes entries committed out of ID order", async (storage) => {
			const rootId = await createRoot(storage);
			await storage.commit(
				[
					{ type: "entry", value: entry(idFromNumber<EntryId>(30), rootId) },
					{ type: "entry", value: entry(idFromNumber<EntryId>(10), rootId) },
					{
						type: "entry",
						value: entry(idFromNumber<EntryId>(20), rootId, "marker", {
							head: idFromNumber<EntryId>(10),
						}),
					},
				],
				context,
			);

			expect(
				(await storage.scanEntries({ conversationId: rootId }, 10, undefined, context)).items.map(({ id }) => id),
			).toEqual([30, 20, 10]);
			expect((await storage.findLatestHeadMarker(rootId, undefined, context))?.id).toBe(20);
		}),

		createCase(options, "continues an entry cursor below its last item after a newer commit", async (storage) => {
			const rootId = await createRoot(storage);
			const oldestId = await storage.mintId<EntryId>();
			const middleId = await storage.mintId<EntryId>();
			const newestId = await storage.mintId<EntryId>();
			await storage.commit(
				[
					{ type: "entry", value: entry(oldestId, rootId) },
					{ type: "entry", value: entry(middleId, rootId) },
					{ type: "entry", value: entry(newestId, rootId) },
				],
				context,
			);

			const first = await storage.scanEntries({ conversationId: rootId }, 2, undefined, context);
			expect(first.items.map(({ id }) => id)).toEqual([newestId, middleId]);
			const appendedId = await storage.mintId<EntryId>();
			await storage.commit([{ type: "entry", value: entry(appendedId, rootId) }], context);
			const second = await storage.scanEntries({ conversationId: rootId }, 2, first.next, context);
			expect(second.items.map(({ id }) => id)).toEqual([oldestId]);
			expect(second.next).toBeUndefined();
		}),

		createCase(options, "paginates conversations by opaque cursor in ascending ID order", async (storage) => {
			const rootId = await createRoot(storage);
			const secondId = await storage.mintId<ConversationId>();
			const thirdId = await storage.mintId<ConversationId>();
			await storage.commit(
				[
					{ type: "conversation", value: { id: thirdId } },
					{ type: "conversation", value: { id: secondId } },
				],
				context,
			);

			const first = await storage.scanConversations({}, 2, undefined, context);
			expect(first.items.map(({ id }) => id)).toEqual([rootId, secondId]);
			expect(first.next).toBeDefined();
			const roundTrippedCursor = JSON.parse(JSON.stringify(first.next)) as NonNullable<typeof first.next>;
			const second = await storage.scanConversations({}, 2, roundTrippedCursor, context);
			expect(second.items.map(({ id }) => id)).toEqual([thirdId]);
			expect(second.next).toBeUndefined();
		}),

		createCase(options, "filters and pages conversations by durable owner edges", async (storage) => {
			const rootId = await createRoot(storage);
			const otherOwnerId = await storage.mintId<ConversationId>();
			const firstTaskId = await storage.mintId<TaskId<JsonValue>>();
			const secondTaskId = await storage.mintId<TaskId<JsonValue>>();
			const firstId = await storage.mintId<ConversationId>();
			const secondId = await storage.mintId<ConversationId>();
			const thirdId = await storage.mintId<ConversationId>();
			await storage.commit(
				[
					{ type: "conversation", value: { id: otherOwnerId } },
					{
						type: "conversation",
						value: { id: firstId, owner: { conversationId: rootId, taskId: firstTaskId } },
					},
					{
						type: "conversation",
						value: { id: secondId, owner: { conversationId: rootId, taskId: secondTaskId } },
					},
					{
						type: "conversation",
						value: { id: thirdId, owner: { conversationId: otherOwnerId, taskId: firstTaskId } },
					},
				],
				context,
			);

			const first = await storage.scanConversations({ ownerConversationId: rootId }, 1, undefined, context);
			expect(first.items.map(({ id }) => id)).toEqual([firstId]);
			expect(first.next).toBeDefined();
			const second = await storage.scanConversations({ ownerConversationId: rootId }, 1, first.next, context);
			expect(second.items.map(({ id }) => id)).toEqual([secondId]);
			expect(second.next).toBeUndefined();
			expect(
				(await storage.scanConversations({ ownerTaskId: firstTaskId }, 10, undefined, context)).items.map(
					({ id }) => id,
				),
			).toEqual([firstId, thirdId]);
			expect(
				(
					await storage.scanConversations(
						{ ownerConversationId: rootId, ownerTaskId: firstTaskId },
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([firstId]);
		}),

		createCase(options, "scans deep fork history newest-first through every ancestor cap", async (storage) => {
			const rootId = await createRoot(storage);
			const rootFirst = await storage.mintId<EntryId>();
			const rootForkPoint = await storage.mintId<EntryId>();
			const rootExcludedSameCommit = await storage.mintId<EntryId>();
			const rootEntriesSeq = await storage.commit(
				[
					{ type: "entry", value: entry(rootFirst, rootId) },
					{
						type: "entry",
						value: entry(rootForkPoint, rootId, "marker", { head: rootFirst }),
					},
					{ type: "entry", value: entry(rootExcludedSameCommit, rootId) },
				],
				context,
			);
			const childId = await storage.mintId<ConversationId>();
			await storage.commit(
				[
					{
						type: "conversation",
						value: { id: childId, parent: { conversationId: rootId, at: rootForkPoint } },
					},
				],
				context,
			);
			const childForkPoint = await storage.mintId<EntryId>();
			const childExcluded = await storage.mintId<EntryId>();
			await storage.commit(
				[
					{ type: "entry", value: entry(childForkPoint, childId, "note") },
					{ type: "entry", value: entry(childExcluded, childId) },
				],
				context,
			);
			const rootExcludedLater = await storage.mintId<EntryId>();
			await storage.commit([{ type: "entry", value: entry(rootExcludedLater, rootId) }], context);
			const grandchildId = await storage.mintId<ConversationId>();
			await storage.commit(
				[
					{
						type: "conversation",
						value: { id: grandchildId, parent: { conversationId: childId, at: childForkPoint } },
					},
				],
				context,
			);
			const grandchildHead = await storage.mintId<EntryId>();
			const grandchildTail = await storage.mintId<EntryId>();
			const grandchildEntriesSeq = await storage.commit(
				[
					{
						type: "entry",
						value: entry(grandchildHead, grandchildId, "marker", { head: grandchildHead }),
					},
					{ type: "entry", value: entry(grandchildTail, grandchildId) },
				],
				context,
			);
			const childExcludedLater = await storage.mintId<EntryId>();
			await storage.commit([{ type: "entry", value: entry(childExcludedLater, childId) }], context);

			const first = await storage.scanEntries({ conversationId: grandchildId }, 2, undefined, context);
			expect(first.items.map(({ id }) => id)).toEqual([grandchildTail, grandchildHead]);
			const second = await storage.scanEntries({ conversationId: grandchildId }, 2, first.next, context);
			expect(second.items.map(({ id }) => id)).toEqual([childForkPoint, rootForkPoint]);
			const third = await storage.scanEntries({ conversationId: grandchildId }, 2, second.next, context);
			expect(third.items.map(({ id }) => id)).toEqual([rootFirst]);
			expect(third.next).toBeUndefined();

			const currentMarker = await storage.findLatestHeadMarker(grandchildId, undefined, context);
			expect(currentMarker?.id).toBe(grandchildHead);
			expect(currentMarker?.head).toBe(grandchildHead);
			const historicalMarker = await storage.findLatestHeadMarker(grandchildId, childForkPoint, context);
			expect(historicalMarker?.id).toBe(rootForkPoint);
			expect(historicalMarker?.head).toBe(rootFirst);
			expect(await storage.findLatestHeadMarker(grandchildId, rootFirst, context)).toBeUndefined();

			const activeFirst = await storage.scanEntries(
				{ conversationId: grandchildId, minEntryId: currentMarker?.head },
				1,
				undefined,
				context,
			);
			expect(activeFirst.items.map(({ id }) => id)).toEqual([grandchildTail]);
			expect(activeFirst.next).toBeDefined();
			const activeSecond = await storage.scanEntries(
				{ conversationId: grandchildId, minEntryId: currentMarker?.head },
				1,
				activeFirst.next,
				context,
			);
			expect(activeSecond.items.map(({ id }) => id)).toEqual([grandchildHead]);
			expect(activeSecond.next).toBeUndefined();

			expect(
				(
					await storage.scanEntries(
						{
							conversationId: grandchildId,
							minEntryId: historicalMarker?.head,
							maxEntryId: childForkPoint,
						},
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([childForkPoint, rootForkPoint, rootFirst]);

			expect(await storage.entry(rootFirst, context)).toEqual({
				entry: entry(rootFirst, rootId),
				commitSeq: rootEntriesSeq,
			});
			expect((await storage.entry(rootForkPoint, context))?.commitSeq).toBe(rootEntriesSeq);
			expect((await storage.entry(grandchildHead, context))?.commitSeq).toBe(grandchildEntriesSeq);
			expect((await storage.entry(grandchildTail, context))?.commitSeq).toBe(grandchildEntriesSeq);
			expect(await storage.entry(idFromNumber<EntryId>(999_999), context)).toBeUndefined();

			expect(await storage.entry(grandchildId, rootFirst, context)).toEqual({
				entry: entry(rootFirst, rootId),
				commitSeq: rootEntriesSeq,
			});
			expect((await storage.entry(grandchildId, childForkPoint, context))?.entry.conversationId).toBe(childId);
			expect((await storage.entry(grandchildId, grandchildTail, context))?.commitSeq).toBe(grandchildEntriesSeq);
			expect(await storage.entry(grandchildId, rootExcludedSameCommit, context)).toBeUndefined();
			expect(await storage.entry(grandchildId, rootExcludedLater, context)).toBeUndefined();
			expect(await storage.entry(grandchildId, childExcluded, context)).toBeUndefined();
			expect(await storage.entry(grandchildId, childExcludedLater, context)).toBeUndefined();
			expect(await storage.entry(rootId, grandchildHead, context)).toBeUndefined();
			expect(await storage.entry(grandchildId, idFromNumber<EntryId>(999_999), context)).toBeUndefined();
			await expect(storage.entry(idFromNumber<ConversationId>(999_999), rootFirst, context)).rejects.toThrow(
				"Unknown conversation",
			);
			await expect(
				storage.scanEntries({ conversationId: idFromNumber<ConversationId>(999_999) }, 10, undefined, context),
			).rejects.toThrow("Unknown conversation");
		}),

		createCase(options, "replaces complete task records and pages filtered task scans", async (storage) => {
			const rootId = await createRoot(storage);
			const firstId = await storage.mintId<TaskId<JsonValue>>();
			const secondId = await storage.mintId<TaskId<JsonValue>>();
			const thirdId = await storage.mintId<TaskId<JsonValue>>();
			const first = { ...pendingTask(firstId, rootId), memos: { winner: "first" } } satisfies StoredTask;
			const second = { ...pendingTask(secondId, rootId), background: true } satisfies StoredTask;
			const third = { ...pendingTask(thirdId, rootId), abortRequested: true } satisfies StoredTask;
			await storage.commit(
				[
					{ type: "task", value: first },
					{ type: "task", value: second },
					{ type: "task", value: third },
				],
				context,
			);

			const running: StoredTask = {
				...first,
				state: { status: "running", checkpoint: { phase: "effect", attempt: 1 } },
				abortRequested: true,
			};
			await storage.commit([{ type: "task", value: running }], context);
			expect(await storage.task(firstId, context)).toEqual(running);
			const terminal: StoredTask = {
				id: firstId,
				conversationId: rootId,
				kind: first.kind,
				version: first.version,
				input: first.input,
				state: { status: "terminal", outcome: { status: "completed", result: { entryId: 99 } } },
				after: [],
				background: false,
				abortRequested: true,
			};
			await storage.commit([{ type: "task", value: terminal }], context);
			expect(await storage.task(firstId, context)).toEqual(terminal);

			const pendingPage = await storage.scanTasks({ status: "pending" }, 1, undefined, context);
			expect(pendingPage.items.map(({ id }) => id)).toEqual([secondId]);
			expect(pendingPage.next).toBeDefined();
			expect(
				(await storage.scanTasks({ status: "pending" }, 1, pendingPage.next, context)).items.map(({ id }) => id),
			).toEqual([thirdId]);
			expect(
				(await storage.scanTasks({ status: "terminal", abortRequested: true }, 10, undefined, context)).items,
			).toEqual([terminal]);
			expect(
				(await storage.scanTasks({ background: true }, 10, undefined, context)).items.map(({ id }) => id),
			).toEqual([secondId]);
		}),

		createCase(
			options,
			"indexes request IDs per conversation and replaces complete submission records",
			async (storage) => {
				const rootId = await createRoot(storage);
				const secondConversationId = await storage.mintId<ConversationId>();
				await storage.commit([{ type: "conversation", value: { id: secondConversationId } }], context);
				const firstId = await storage.mintId<SubmissionId>();
				const secondId = await storage.mintId<SubmissionId>();
				const otherConversationId = await storage.mintId<SubmissionId>();
				const first: SubmissionRecord = {
					id: firstId,
					conversationId: rootId,
					requestId: "same",
					type: "input",
					status: "queued",
				};
				const second: SubmissionRecord = {
					id: secondId,
					conversationId: rootId,
					requestId: "other",
					type: "input",
					status: "queued",
				};
				const otherConversation: SubmissionRecord = {
					id: otherConversationId,
					conversationId: secondConversationId,
					requestId: "same",
					type: "input",
					status: "queued",
				};
				await storage.commit(
					[
						{ type: "submission", value: first },
						{ type: "submission", value: second },
						{ type: "submission", value: otherConversation },
					],
					context,
				);
				expect(await storage.submissionByRequest(rootId, "same", context)).toEqual(first);
				expect(await storage.submissionByRequest(secondConversationId, "same", context)).toEqual(otherConversation);

				const placedSecond: SubmissionRecord = {
					...second,
					status: "placed",
					entry: await storage.mintId<EntryId>(),
				};
				await storage.commit([{ type: "submission", value: placedSecond }], context);
				expect(await storage.submission(secondId, context)).toEqual(placedSecond);
				expect(await storage.submissionByRequest(rootId, "other", context)).toEqual(placedSecond);
			},
		),

		createCase(options, "stores passive write submissions without input-only lifecycle states", async (storage) => {
			const rootId = await createRoot(storage);
			const doneId = await storage.mintId<SubmissionId>();
			const failedId = await storage.mintId<SubmissionId>();
			const queuedDone: SubmissionRecord = {
				id: doneId,
				conversationId: rootId,
				requestId: "passive-done",
				type: "write",
				status: "queued",
			};
			const queuedFailed: SubmissionRecord = {
				id: failedId,
				conversationId: rootId,
				requestId: "passive-failed",
				type: "write",
				status: "queued",
			};
			await storage.commit(
				[
					{ type: "submission", value: queuedDone },
					{ type: "submission", value: queuedFailed },
				],
				context,
			);

			const done: SubmissionRecord = {
				...queuedDone,
				status: "done",
				entry: await storage.mintId<EntryId>(),
			};
			const unanswered: SubmissionRecord = {
				...queuedFailed,
				status: "unanswered",
				reason: "closed",
				detail: { retryable: false },
			};
			await storage.commit(
				[
					{ type: "submission", value: done },
					{ type: "submission", value: unanswered },
				],
				context,
			);
			expect(await storage.submission(doneId, context)).toEqual(done);
			expect(await storage.submissionByRequest(rootId, "passive-done", context)).toEqual(done);
			expect(await storage.submission(failedId, context)).toEqual(unanswered);
			expect(await storage.submissionByRequest(rootId, "passive-failed", context)).toEqual(unanswered);
		}),

		createCase(options, "reconstructs rewindable documents and preserves half-open incarnations", async (storage) => {
			const rootId = await createRoot(storage);
			const firstId = await storage.mintId<DocumentId>();
			const firstRecord = {
				id: firstId,
				kind: "conversation.notes",
				scope: { kind: "conversation", conversationId: rootId },
				history: "rewindable",
				fork: "asOf",
			} satisfies DocumentCreate;
			const initial: JsonObject = { items: ["a"], nested: { count: 1 } };
			const createdAt = await storage.commit(
				[
					{
						type: "document.create",
						record: firstRecord,
						content: { kind: "base", version: 1, value: initial },
					},
				],
				context,
			);
			const appended = ["b"];
			const ops: Op[] = [
				["p", ["items"], 1, 0, appended],
				["s", ["nested", "count"], 2],
			];
			const changedAt = await storage.commit(
				[{ type: "document.change", id: firstId, content: { kind: "delta", version: 1, ops } }],
				context,
			);

			(initial.items as string[]).push("caller mutation");
			appended.push("caller mutation");
			expect(await storage.document(firstId, createdAt, context)).toMatchObject({
				version: 1,
				value: { items: ["a"], nested: { count: 1 } },
			});
			const changed = (await storage.document(firstId, changedAt, context))!;
			expect(changed.value).toEqual({ items: ["a", "b"], nested: { count: 2 } });
			(changed.value.items as string[]).push("read mutation");
			expect((await storage.document(firstId, "current", context))?.value).toEqual({
				items: ["a", "b"],
				nested: { count: 2 },
			});

			const checkpointAt = await storage.commit(
				[
					{
						type: "document.change",
						id: firstId,
						content: { kind: "base", version: 2, value: { items: ["checkpoint"], nested: { count: 3 } } },
					},
				],
				context,
			);
			const replacedAt = await storage.commit(
				[
					{
						type: "document.change",
						id: firstId,
						content: {
							kind: "delta",
							version: 2,
							ops: [["r", { items: ["replacement"], nested: { count: 4 } }]],
						},
					},
				],
				context,
			);
			expect(await storage.document(firstId, changedAt, context)).toMatchObject({
				version: 1,
				value: { items: ["a", "b"], nested: { count: 2 } },
			});
			expect(await storage.document(firstId, checkpointAt, context)).toMatchObject({
				version: 2,
				value: { items: ["checkpoint"], nested: { count: 3 } },
			});
			expect((await storage.document(firstId, replacedAt, context))?.value).toEqual({
				items: ["replacement"],
				nested: { count: 4 },
			});

			const secondId = await storage.mintId<DocumentId>();
			const retiredAt = await storage.commit(
				[
					{
						type: "document.create",
						record: { ...firstRecord, id: secondId },
						content: { kind: "base", version: 1, value: { items: ["new"] } },
					},
					{ type: "document.retire", id: firstId },
					{
						type: "document.change",
						id: firstId,
						content: { kind: "delta", version: 2, ops: [["s", ["retiring"], true]] },
					},
				],
				context,
			);
			const address = { kind: firstRecord.kind, scope: firstRecord.scope };
			expect((await storage.findDocument(address, changedAt, context))?.id).toBe(firstId);
			expect(await storage.findDocument(address, retiredAt, context)).toMatchObject({
				id: secondId,
				createdAt: retiredAt,
			});
			expect(
				(
					await storage.scanDocuments({ scope: firstRecord.scope, at: changedAt }, 10, undefined, context)
				).items.map(({ id }) => id),
			).toEqual([firstId]);
			expect(
				(
					await storage.scanDocuments({ scope: firstRecord.scope, at: retiredAt }, 10, undefined, context)
				).items.map(({ id }) => id),
			).toEqual([secondId]);
			expect(await storage.document(firstId, retiredAt, context)).toBeUndefined();
			expect((await storage.document(secondId, "current", context))?.value).toEqual({ items: ["new"] });
		}),

		createCase(options, "streams long document tails across root replacement deltas", async (storage) => {
			const rootId = await createRoot(storage);
			const id = await storage.mintId<DocumentId>();
			const record = {
				id,
				kind: "conversation.long-tail",
				scope: { kind: "conversation", conversationId: rootId },
				history: "rewindable",
				fork: "asOf",
			} satisfies DocumentCreate;
			const initial = {
				revision: 0,
				rows: Array.from({ length: 512 }, (_, value) => ({ value, stable: `row-${value}` })),
			};
			const createdAt = await storage.commit(
				[{ type: "document.create", record, content: { kind: "base", version: 1, value: initial } }],
				context,
			);
			const beforeReplacement = structuredClone(initial);
			let beforeReplacementAt = createdAt;
			for (let revision = 1; revision <= 24; revision++) {
				const index = (revision * 17) % beforeReplacement.rows.length;
				beforeReplacement.rows[index]!.value = -revision;
				beforeReplacement.revision = revision;
				beforeReplacementAt = await storage.commit(
					[
						{
							type: "document.change",
							id,
							content: {
								kind: "delta",
								version: 1,
								ops: [
									["s", ["rows", index, "value"], -revision],
									["s", ["revision"], revision],
								],
							},
						},
					],
					context,
				);
			}

			const replacement = {
				revision: 100,
				rows: Array.from({ length: 512 }, (_, value) => ({ value: 10_000 + value, stable: `new-${value}` })),
			};
			const replacementSnapshot = structuredClone(replacement);
			const replacementAt = await storage.commit(
				[
					{
						type: "document.change",
						id,
						content: { kind: "delta", version: 1, ops: [["r", replacement]] },
					},
				],
				context,
			);
			replacement.rows[0]!.value = -999;

			const current = structuredClone(replacementSnapshot);
			for (let revision = 101; revision <= 124; revision++) {
				const index = (revision * 19) % current.rows.length;
				current.rows[index]!.value = -revision;
				current.revision = revision;
				await storage.commit(
					[
						{
							type: "document.change",
							id,
							content: {
								kind: "delta",
								version: 1,
								ops: [
									["s", ["rows", index, "value"], -revision],
									["s", ["revision"], revision],
								],
							},
						},
					],
					context,
				);
			}

			expect((await storage.document(id, createdAt, context))?.value).toEqual(initial);
			expect((await storage.document(id, beforeReplacementAt, context))?.value).toEqual(beforeReplacement);
			expect((await storage.document(id, replacementAt, context))?.value).toEqual(replacementSnapshot);
			const read = (await storage.document(id, "current", context))!;
			expect(read.value).toEqual(current);
			(read.value.rows as Array<{ value: number }>)[0]!.value = -1_000;
			expect((await storage.document(id, "current", context))?.value).toEqual(current);
		}),

		createCase(
			options,
			"copies stored document bases independently and rejects ambiguous sources",
			async (storage) => {
				const rootId = await createRoot(storage);
				const childId = await storage.mintId<ConversationId>();
				const secondChildId = await storage.mintId<ConversationId>();
				await storage.commit(
					[
						{ type: "conversation", value: { id: childId } },
						{ type: "conversation", value: { id: secondChildId } },
					],
					context,
				);
				const sourceId = await storage.mintId<DocumentId>();
				const sourceRecord = {
					id: sourceId,
					kind: "copy.source",
					scope: { kind: "conversation", conversationId: rootId },
					history: "rewindable",
					fork: "asOf",
				} satisfies DocumentCreate;
				const createdAt = await storage.commit(
					[
						{
							type: "document.create",
							record: sourceRecord,
							content: { kind: "base", version: 2, value: { count: 1, rows: [{ value: "base" }] } },
						},
					],
					context,
				);
				await storage.commit(
					[
						{
							type: "document.change",
							id: sourceId,
							content: {
								kind: "delta",
								version: 2,
								ops: [
									["s", ["count"], 2],
									["p", ["rows"], 1, 0, [{ value: "current" }]],
								],
							},
						},
					],
					context,
				);
				const historicalCopyId = await storage.mintId<DocumentId>();
				const currentCopyId = await storage.mintId<DocumentId>();
				const retiredCopyId = await storage.mintId<DocumentId>();
				const childRecord = (id: DocumentId, conversationId: ConversationId): DocumentCreate => ({
					id,
					kind: sourceRecord.kind,
					scope: { kind: "conversation", conversationId },
					history: "rewindable",
					fork: "asOf",
				});
				await storage.commit(
					[
						{
							type: "document.copy",
							record: childRecord(historicalCopyId, childId),
							source: { id: sourceId, at: createdAt },
						},
						{
							type: "document.copy",
							record: childRecord(currentCopyId, secondChildId),
							source: { id: sourceId, at: "current" },
						},
						{
							type: "document.copy",
							record: childRecord(retiredCopyId, rootId),
							source: { id: sourceId, at: "current" },
						},
						{ type: "document.retire", id: retiredCopyId },
					],
					context,
				);
				expect(await storage.document(historicalCopyId, "current", context)).toMatchObject({
					version: 2,
					value: { count: 1, rows: [{ value: "base" }] },
				});
				expect(await storage.document(currentCopyId, "current", context)).toMatchObject({
					version: 2,
					value: { count: 2, rows: [{ value: "base" }, { value: "current" }] },
				});
				expect(await storage.document(retiredCopyId, "current", context)).toBeUndefined();

				await storage.commit(
					[
						{
							type: "document.change",
							id: sourceId,
							content: { kind: "base", version: 2, value: { count: 99, rows: [] } },
						},
						{ type: "document.retire", id: sourceId },
					],
					context,
				);
				expect((await storage.document(currentCopyId, "current", context))?.value).toEqual({
					count: 2,
					rows: [{ value: "base" }, { value: "current" }],
				});

				const latestSourceId = await storage.mintId<DocumentId>();
				const latestCopyId = await storage.mintId<DocumentId>();
				const latestSource = {
					id: latestSourceId,
					kind: "copy.latest",
					scope: { kind: "conversation", conversationId: rootId },
					history: "latest",
					fork: "current",
				} satisfies DocumentCreate;
				await storage.commit(
					[
						{
							type: "document.create",
							record: latestSource,
							content: { kind: "base", version: 4, value: { retained: "copy" } },
						},
					],
					context,
				);
				await storage.commit(
					[
						{
							type: "document.copy",
							record: {
								...latestSource,
								id: latestCopyId,
								scope: { kind: "conversation", conversationId: childId },
							},
							source: { id: latestSourceId, at: "current" },
						},
					],
					context,
				);
				await storage.commit(
					[
						{
							type: "document.change",
							id: latestSourceId,
							content: { kind: "base", version: 4, value: { retained: "source-only" } },
						},
						{ type: "document.retire", id: latestSourceId },
					],
					context,
				);
				expect(await storage.document(latestCopyId, "current", context)).toMatchObject({
					version: 4,
					value: { retained: "copy" },
				});

				const conflictId = await storage.mintId<DocumentId>();
				let conflictError: unknown;
				try {
					await storage.commit(
						[
							{
								type: "document.copy",
								record: childRecord(conflictId, childId),
								source: { id: currentCopyId, at: "current" },
							},
							{ type: "document.retire", id: currentCopyId },
						],
						context,
					);
				} catch (error) {
					conflictError = error;
				}
				expect((conflictError as Error | undefined)?.name).toBe("StorageRejected");
				expect(await storage.document(conflictId, "current", context)).toBeUndefined();
				expect((await storage.document(currentCopyId, "current", context))?.value).toEqual({
					count: 2,
					rows: [{ value: "base" }, { value: "current" }],
				});

				const mismatchId = await storage.mintId<DocumentId>();
				let mismatchError: unknown;
				try {
					await storage.commit(
						[
							{
								type: "document.copy",
								record: { ...childRecord(mismatchId, childId), kind: "copy.mismatch" },
								source: { id: currentCopyId, at: "current" },
							},
						],
						context,
					);
				} catch (error) {
					mismatchError = error;
				}
				expect((mismatchError as Error | undefined)?.name).toBe("StorageRejected");
				expect(await storage.document(mismatchId, "current", context)).toBeUndefined();
			},
		),

		createCase(
			options,
			"uses bases for version transitions and rejects historical reads of current-only documents",
			async (storage) => {
				await createRoot(storage);
				const id = await storage.mintId<DocumentId>();
				const record = {
					id,
					kind: "session.settings",
					scope: { kind: "session" },
				} satisfies DocumentCreate;
				await storage.commit(
					[{ type: "document.create", record, content: { kind: "base", version: 1, value: { count: 1 } } }],
					context,
				);
				await storage.commit(
					[{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] } }],
					context,
				);
				const migratedAt = await storage.commit(
					[{ type: "document.change", id, content: { kind: "base", version: 2, value: { count: 3 } } }],
					context,
				);
				expect(await storage.document(id, "current", context)).toMatchObject({ version: 2, value: { count: 3 } });
				await expect(storage.document(id, migratedAt, context)).rejects.toThrow(
					"does not retain historical content",
				);

				await expect(
					storage.commit(
						[{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["count"], 4]] } }],
						context,
					),
				).rejects.toThrow("version transition requires a base");
				expect((await storage.document(id, "current", context))?.value).toEqual({ count: 3 });
				await storage.commit([{ type: "document.retire", id }], context);
				expect(await storage.document(id, "current", context)).toBeUndefined();
			},
		),

		createCase(options, "indexes logical addresses and exact-scope scans independently", async (storage) => {
			const rootId = await createRoot(storage);
			const firstId = await storage.mintId<DocumentId>();
			const secondId = await storage.mintId<DocumentId>();
			const conversationId = await storage.mintId<DocumentId>();
			const taskId = await storage.mintId<TaskId<JsonValue>>();
			const taskSingletonId = await storage.mintId<DocumentId>();
			const taskFamilyId = await storage.mintId<DocumentId>();
			const taskOtherKindId = await storage.mintId<DocumentId>();
			const createdAt = await storage.commit(
				[
					{ type: "task", value: pendingTask(taskId, rootId) },
					{
						type: "document.create",
						record: {
							id: firstId,
							kind: "cache",
							scope: { kind: "session" },
							key: "__proto__",
						},
						content: { kind: "base", version: 1, value: { owner: "first" } },
					},
					{
						type: "document.create",
						record: {
							id: secondId,
							kind: "cache",
							scope: { kind: "session" },
							key: "constructor",
						},
						content: { kind: "base", version: 1, value: { owner: "second" } },
					},
					{
						type: "document.create",
						record: {
							id: conversationId,
							kind: "cache",
							scope: { kind: "conversation", conversationId: rootId },
							history: "latest",
							fork: "current",
							key: "__proto__",
						},
						content: { kind: "base", version: 1, value: { owner: "conversation" } },
					},
					{
						type: "document.create",
						record: {
							id: taskSingletonId,
							kind: "task.cache",
							scope: { kind: "task", taskId },
						},
						content: { kind: "base", version: 1, value: { owner: "singleton" } },
					},
					{
						type: "document.create",
						record: {
							id: taskFamilyId,
							kind: "task.cache",
							scope: { kind: "task", taskId },
							key: "member",
						},
						content: { kind: "base", version: 1, value: { owner: "family" } },
					},
					{
						type: "document.create",
						record: {
							id: taskOtherKindId,
							kind: "task.other",
							scope: { kind: "task", taskId },
						},
						content: { kind: "base", version: 1, value: { owner: "other" } },
					},
				],
				context,
			);

			expect(
				(
					await storage.findDocument(
						{ kind: "cache", scope: { kind: "session" }, key: "__proto__" },
						"current",
						context,
					)
				)?.id,
			).toBe(firstId);
			expect(
				(await storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 1, undefined, context)).items,
			).toHaveLength(1);
			const first = await storage.scanDocuments(
				{ scope: { kind: "session" }, at: "current" },
				1,
				undefined,
				context,
			);
			const second = await storage.scanDocuments(
				{ scope: { kind: "session" }, at: "current" },
				1,
				first.next,
				context,
			);
			expect([...first.items, ...second.items].map(({ id }) => id)).toEqual([firstId, secondId]);
			expect(
				(
					await storage.scanDocuments(
						{ scope: { kind: "conversation", conversationId: rootId }, at: "current" },
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([conversationId]);
			expect(
				(await storage.findDocument({ kind: "task.cache", scope: { kind: "task", taskId } }, "current", context))
					?.id,
			).toBe(taskSingletonId);
			expect(
				(
					await storage.findDocument(
						{ kind: "task.cache", scope: { kind: "task", taskId }, key: "member" },
						"current",
						context,
					)
				)?.id,
			).toBe(taskFamilyId);
			expect(
				(
					await storage.scanDocuments(
						{ scope: { kind: "task", taskId }, at: "current", kind: "task.cache" },
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([taskSingletonId, taskFamilyId]);
			await expect(storage.document(taskSingletonId, createdAt, context)).rejects.toThrow(
				"does not retain historical content",
			);
		}),

		createCase(
			options,
			"keeps document lifecycle failures atomic and gives create-plus-retire an empty lifetime",
			async (storage) => {
				const rootId = await createRoot(storage);
				const firstId = await storage.mintId<DocumentId>();
				const secondId = await storage.mintId<DocumentId>();
				const record = {
					id: firstId,
					kind: "singleton",
					scope: { kind: "session" },
				} satisfies DocumentCreate;
				await storage.commit(
					[{ type: "document.create", record, content: { kind: "base", version: 1, value: { value: 1 } } }],
					context,
				);
				await expect(
					storage.commit(
						[
							{
								type: "document.create",
								record: { ...record, id: secondId },
								content: { kind: "base", version: 1, value: { value: 2 } },
							},
							{ type: "document.change", id: firstId, content: { kind: "delta", version: 1, ops: [] } },
						],
						context,
					),
				).rejects.toThrow("already has a current incarnation");
				expect((await storage.document(firstId, "current", context))?.value).toEqual({ value: 1 });
				expect(await storage.document(secondId, "current", context)).toBeUndefined();

				const emptyId = await storage.mintId<DocumentId>();
				const emptyAt = await storage.commit(
					[
						{
							type: "document.create",
							record: {
								id: emptyId,
								kind: record.kind,
								key: "empty",
								scope: { kind: "conversation", conversationId: rootId },
								history: "rewindable",
								fork: "initial",
							},
							content: { kind: "base", version: 1, value: {} },
						},
						{ type: "document.retire", id: emptyId },
					],
					context,
				);
				expect(await storage.document(emptyId, "current", context)).toBeUndefined();
				expect(await storage.document(emptyId, emptyAt, context)).toBeUndefined();
				expect(
					await storage.findDocument(
						{
							kind: record.kind,
							scope: { kind: "conversation", conversationId: rootId },
							key: "empty",
						},
						emptyAt,
						context,
					),
				).toBeUndefined();
			},
		),

		createCase(
			options,
			"rolls back record tables and secondary indexes when a document command fails",
			async (storage) => {
				const rootId = await createRoot(storage);
				const taskId = await storage.mintId<TaskId<JsonValue>>();
				const submissionId = await storage.mintId<SubmissionId>();
				const documentId = await storage.mintId<DocumentId>();
				const task = pendingTask(taskId, rootId);
				const submission: SubmissionRecord = {
					id: submissionId,
					conversationId: rootId,
					requestId: "atomic",
					type: "input",
					status: "queued",
				};
				const record = {
					id: documentId,
					kind: "atomic",
					scope: { kind: "session" },
				} satisfies DocumentCreate;
				const baselineSeq = await storage.commit(
					[
						{ type: "task", value: task },
						{ type: "submission", value: submission },
						{ type: "document.create", record, content: { kind: "base", version: 1, value: { count: 1 } } },
					],
					context,
				);

				const entryId = await storage.mintId<EntryId>();
				const conflictingDocumentId = await storage.mintId<DocumentId>();
				await expect(
					storage.commit(
						[
							{
								type: "task",
								value: { ...task, state: { status: "running", checkpoint: { phase: "effect" } } },
							},
							{
								type: "submission",
								value: { ...submission, status: "unanswered", reason: "failed" },
							},
							{ type: "entry", value: entry(entryId, rootId, "transient") },
							{
								type: "document.create",
								record: { ...record, id: conflictingDocumentId },
								content: { kind: "base", version: 1, value: { count: 2 } },
							},
						],
						context,
					),
				).rejects.toThrow("already has a current incarnation");

				expect(await storage.task(taskId, context)).toEqual(task);
				expect((await storage.scanTasks({ status: "pending" }, 10, undefined, context)).items).toEqual([task]);
				expect(await storage.submissionByRequest(rootId, "atomic", context)).toEqual(submission);
				expect(await storage.entry(entryId, context)).toBeUndefined();
				expect(await storage.document(conflictingDocumentId, "current", context)).toBeUndefined();
				expect(
					(await storage.findDocument({ kind: record.kind, scope: record.scope }, "current", context))?.id,
				).toBe(documentId);
				const afterRollbackSeq = await storage.commit(
					[
						{
							type: "document.change",
							id: documentId,
							content: { kind: "delta", version: 1, ops: [["s", ["count"], 3]] },
						},
					],
					context,
				);
				expect(afterRollbackSeq).toBeGreaterThan(baselineSeq);
			},
		),

		createCase(options, "keeps indexed string identities lossless", async (storage) => {
			const rootId = await createRoot(storage);
			const first = "\ud800";
			const second = "\ud801";
			const firstTaskId = await storage.mintId<TaskId<JsonValue>>();
			const secondTaskId = await storage.mintId<TaskId<JsonValue>>();
			const firstSubmissionId = await storage.mintId<SubmissionId>();
			const secondSubmissionId = await storage.mintId<SubmissionId>();
			const firstKindDocumentId = await storage.mintId<DocumentId>();
			const secondKindDocumentId = await storage.mintId<DocumentId>();
			const firstKeyDocumentId = await storage.mintId<DocumentId>();
			const secondKeyDocumentId = await storage.mintId<DocumentId>();
			await storage.commit(
				[
					{ type: "task", value: { ...pendingTask(firstTaskId, rootId), kind: first } },
					{ type: "task", value: { ...pendingTask(secondTaskId, rootId), kind: second } },
					{
						type: "submission",
						value: {
							id: firstSubmissionId,
							conversationId: rootId,
							requestId: first,
							type: "input",
							status: "queued",
						},
					},
					{
						type: "submission",
						value: {
							id: secondSubmissionId,
							conversationId: rootId,
							requestId: second,
							type: "input",
							status: "queued",
						},
					},
					{
						type: "document.create",
						record: { id: firstKindDocumentId, kind: first, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { identity: "first kind" } },
					},
					{
						type: "document.create",
						record: { id: secondKindDocumentId, kind: second, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { identity: "second kind" } },
					},
					{
						type: "document.create",
						record: { id: firstKeyDocumentId, kind: "family", key: first, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { identity: "first key" } },
					},
					{
						type: "document.create",
						record: { id: secondKeyDocumentId, kind: "family", key: second, scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { identity: "second key" } },
					},
				],
				context,
			);

			expect((await storage.scanTasks({ kind: first }, 10, undefined, context)).items.map(({ id }) => id)).toEqual([
				firstTaskId,
			]);
			expect((await storage.scanTasks({ kind: second }, 10, undefined, context)).items.map(({ id }) => id)).toEqual([
				secondTaskId,
			]);
			expect((await storage.task(firstTaskId, context))?.kind).toBe(first);
			expect((await storage.task(secondTaskId, context))?.kind).toBe(second);
			expect((await storage.submissionByRequest(rootId, first, context))?.requestId).toBe(first);
			expect((await storage.submissionByRequest(rootId, first, context))?.id).toBe(firstSubmissionId);
			expect((await storage.submissionByRequest(rootId, second, context))?.id).toBe(secondSubmissionId);
			expect((await storage.findDocument({ kind: first, scope: { kind: "session" } }, "current", context))?.id).toBe(
				firstKindDocumentId,
			);
			expect(
				(await storage.findDocument({ kind: second, scope: { kind: "session" } }, "current", context))?.id,
			).toBe(secondKindDocumentId);
			expect(
				(await storage.findDocument({ kind: "family", key: first, scope: { kind: "session" } }, "current", context))
					?.id,
			).toBe(firstKeyDocumentId);
			expect(
				(
					await storage.findDocument(
						{ kind: "family", key: second, scope: { kind: "session" } },
						"current",
						context,
					)
				)?.id,
			).toBe(secondKeyDocumentId);
			expect(
				(
					await storage.scanDocuments(
						{ scope: { kind: "session" }, at: "current", kind: first },
						10,
						undefined,
						context,
					)
				).items.map(({ id }) => id),
			).toEqual([firstKindDocumentId]);
		}),

		createCase(options, "keeps one global record ID namespace and rejects exhausted ID minting", async (storage) => {
			const rootId = await createRoot(storage);
			const explicitEntryId = idFromNumber<EntryId>(100);
			await storage.commit([{ type: "entry", value: entry(explicitEntryId, rootId) }], context);
			expect(await storage.mintId<EntryId>()).toBe(101);
			await expect(
				storage.commit(
					[{ type: "task", value: pendingTask(idFromNumber<TaskId<JsonValue>>(explicitEntryId), rootId) }],
					context,
				),
			).rejects.toThrow(`ID ${explicitEntryId} already belongs to entry`);

			await storage.commit(
				[{ type: "entry", value: entry(idFromNumber<EntryId>(Number.MAX_SAFE_INTEGER), rootId, "last-id") }],
				context,
			);
			await expect(storage.mintId<EntryId>()).rejects.toThrow("ID space is exhausted");
			await expect(storage.mintId<EntryId>()).rejects.toThrow("ID space is exhausted");
		}),

		createCase(options, "rejects every operation after close", async (storage) => {
			await createRoot(storage);
			await storage.close(context);
			await expect(storage.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("closed");
			await expect(storage.commit([] satisfies StorageWrite[], context)).rejects.toThrow("closed");
			await expect(storage.mintId<ConversationId>()).rejects.toThrow("closed");
		}),
	];
}
