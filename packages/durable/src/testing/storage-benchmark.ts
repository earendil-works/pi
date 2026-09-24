import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentCreate, Id, Seq, Storage, StorageWrite, TaskRecord } from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";

export type StorageBenchmarkScale = {
	readonly name: string;
	readonly entryCount: number;
	readonly taskCount: number;
	readonly documentCount: number;
};

export const STORAGE_MEMORY_SCALES: readonly StorageBenchmarkScale[] = [
	{ name: "1k", entryCount: 1_000, taskCount: 200, documentCount: 200 },
	{ name: "10k", entryCount: 10_000, taskCount: 2_000, documentCount: 2_000 },
];

export const TIMING_SCALE: StorageBenchmarkScale = {
	name: "timing",
	entryCount: 1_000,
	taskCount: 300,
	documentCount: 300,
};

const REPLAY_TAILS = [0, 16, 128, 1_024] as const;
const HISTORY_SEGMENT_LENGTH = 128;
const FORK_DEPTH = 8;
const ENTRIES_PER_FORK = 32;
const BATCH_SIZE = 100;

export function storageBenchmarkPrimaryRecordCount(scale: StorageBenchmarkScale): number {
	return (
		1 +
		scale.entryCount +
		scale.taskCount +
		scale.documentCount +
		REPLAY_TAILS.length +
		1 +
		FORK_DEPTH * (1 + ENTRIES_PER_FORK)
	);
}

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

export type StorageBenchmarkDataset = {
	readonly firstEntryId: Id;
	readonly filteredTaskCount: number;
	readonly exactDocumentId: Id;
	readonly exactDocumentKey: string;
	readonly replayDocumentIds: Readonly<Record<(typeof REPLAY_TAILS)[number], Id>>;
	readonly historicalDocumentId: Id;
	readonly ancientAt: Seq;
	readonly recentAt: Seq;
	readonly deepestConversationId: Id;
	readonly ancestorHeadEntryId: Id;
};

function task(id: Id, index: number): StoredTask {
	const statuses = ["pending", "running", "terminal"] as const;
	const status = statuses[index % statuses.length];
	const common = {
		id,
		conversationId: ROOT_CONVERSATION_ID,
		kind: index % 4 === 0 ? "benchmark.filtered" : "benchmark.other",
		version: 1,
		input: { index },
		after: [],
		background: index % 5 === 0,
		abortRequested: index % 7 === 0,
	};
	if (status === "terminal") {
		return { ...common, state: { status, outcome: { status: "completed", result: { index } } } };
	}
	return { ...common, state: { status, checkpoint: { index, payload: "x".repeat(64) } } };
}

/** Seed deterministic representative data through only the public `Storage` contract. */
export async function seedStorageBenchmark(
	storage: Storage,
	scale: StorageBenchmarkScale = TIMING_SCALE,
): Promise<StorageBenchmarkDataset> {
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);

	let firstEntryId = 0;
	for (let start = 0; start < scale.entryCount; start += BATCH_SIZE) {
		const writes: StorageWrite[] = [];
		for (let index = start; index < Math.min(start + BATCH_SIZE, scale.entryCount); index++) {
			const id = await storage.mintId();
			if (index === 0) firstEntryId = id;
			writes.push({
				type: "entry",
				value: {
					id,
					conversationId: ROOT_CONVERSATION_ID,
					kind: "benchmark.entry",
					...(index === 0 ? { head: id } : {}),
					data: { index, text: `entry-${index}-${"x".repeat(96)}` },
				},
			});
		}
		await storage.commit(writes, BACKGROUND_CONTEXT);
	}

	for (let start = 0; start < scale.taskCount; start += BATCH_SIZE) {
		const writes: StorageWrite[] = [];
		for (let index = start; index < Math.min(start + BATCH_SIZE, scale.taskCount); index++) {
			writes.push({ type: "task", value: task(await storage.mintId(), index) });
		}
		await storage.commit(writes, BACKGROUND_CONTEXT);
	}

	let exactDocumentId = 0;
	for (let start = 0; start < scale.documentCount; start += BATCH_SIZE) {
		const writes: StorageWrite[] = [];
		for (let index = start; index < Math.min(start + BATCH_SIZE, scale.documentCount); index++) {
			const id = await storage.mintId();
			exactDocumentId = id;
			writes.push({
				type: "document.create",
				record: { id, kind: "benchmark.family", key: `key-${index}`, scope: { kind: "session" } },
				content: { kind: "base", version: 1, value: { index, text: "x".repeat(128) } },
			});
		}
		await storage.commit(writes, BACKGROUND_CONTEXT);
	}

	const replayEntries = await Promise.all(
		REPLAY_TAILS.map(async (tail) => {
			const id = await storage.mintId();
			return { tail, id };
		}),
	);
	await storage.commit(
		replayEntries.map(({ tail, id }) => ({
			type: "document.create" as const,
			record: {
				id,
				kind: "benchmark.replay",
				key: String(tail),
				scope: { kind: "conversation" as const, conversationId: ROOT_CONVERSATION_ID },
				history: "rewindable" as const,
				fork: "asOf" as const,
			},
			content: { kind: "base" as const, version: 1, value: { count: 0, text: "x".repeat(64) } },
		})),
		BACKGROUND_CONTEXT,
	);
	for (let count = 1; count <= REPLAY_TAILS.at(-1)!; count++) {
		await storage.commit(
			replayEntries
				.filter(({ tail }) => count <= tail)
				.map(({ id }) => ({
					type: "document.change" as const,
					id,
					content: { kind: "delta" as const, version: 1, ops: [["s", ["count"], count] as const] },
				})),
			BACKGROUND_CONTEXT,
		);
	}

	const historicalDocumentId = await storage.mintId();
	const historicalRecord = {
		id: historicalDocumentId,
		kind: "benchmark.history",
		scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
		history: "rewindable",
		fork: "asOf",
	} satisfies DocumentCreate;
	await storage.commit(
		[
			{
				type: "document.create",
				record: historicalRecord,
				content: { kind: "base", version: 1, value: { count: 0 } },
			},
		],
		BACKGROUND_CONTEXT,
	);
	let ancientAt = 0;
	for (let count = 1; count <= HISTORY_SEGMENT_LENGTH; count++) {
		ancientAt = await storage.commit(
			[
				{
					type: "document.change",
					id: historicalDocumentId,
					content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
				},
			],
			BACKGROUND_CONTEXT,
		);
	}
	await storage.commit(
		[
			{
				type: "document.change",
				id: historicalDocumentId,
				content: { kind: "base", version: 1, value: { count: HISTORY_SEGMENT_LENGTH } },
			},
		],
		BACKGROUND_CONTEXT,
	);
	let recentAt = ancientAt;
	for (let count = HISTORY_SEGMENT_LENGTH + 1; count <= HISTORY_SEGMENT_LENGTH * 2; count++) {
		recentAt = await storage.commit(
			[
				{
					type: "document.change",
					id: historicalDocumentId,
					content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
				},
			],
			BACKGROUND_CONTEXT,
		);
	}

	let parentConversationId = ROOT_CONVERSATION_ID;
	let parentAt = firstEntryId;
	let deepestConversationId = ROOT_CONVERSATION_ID;
	for (let depth = 0; depth < FORK_DEPTH; depth++) {
		const conversationId = await storage.mintId();
		await storage.commit(
			[
				{
					type: "conversation",
					value: { id: conversationId, parent: { conversationId: parentConversationId, at: parentAt } },
				},
			],
			BACKGROUND_CONTEXT,
		);
		const ids = await Promise.all(Array.from({ length: ENTRIES_PER_FORK }, () => storage.mintId()));
		await storage.commit(
			ids.map((id, index) => ({
				type: "entry" as const,
				value: {
					id,
					conversationId,
					kind: "benchmark.fork",
					data: { depth, index },
				},
			})),
			BACKGROUND_CONTEXT,
		);
		parentConversationId = conversationId;
		parentAt = ids.at(-1)!;
		deepestConversationId = conversationId;
	}

	return {
		firstEntryId,
		filteredTaskCount: Math.min(50, Math.ceil(scale.taskCount / 60)),
		exactDocumentId,
		exactDocumentKey: `key-${scale.documentCount - 1}`,
		replayDocumentIds: Object.fromEntries(replayEntries.map(({ tail, id }) => [tail, id])) as Record<
			(typeof REPLAY_TAILS)[number],
			Id
		>,
		historicalDocumentId,
		ancientAt,
		recentAt,
		deepestConversationId,
		ancestorHeadEntryId: firstEntryId,
	};
}

export type StorageReadBenchmark = {
	readonly name: string;
	run(storage: Storage, dataset: StorageBenchmarkDataset): Promise<number>;
	expected(dataset: StorageBenchmarkDataset): number;
};

export const STORAGE_READ_BENCHMARKS: readonly StorageReadBenchmark[] = [
	{
		name: "exact entry lookup",
		async run(storage, dataset) {
			return (await storage.entry(dataset.firstEntryId, BACKGROUND_CONTEXT))?.entry.id ?? -1;
		},
		expected: ({ firstEntryId }) => firstEntryId,
	},
	{
		name: "entry page scan (100)",
		async run(storage) {
			return (
				await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, undefined, 100, BACKGROUND_CONTEXT)
			).items.length;
		},
		expected: () => 100,
	},
	{
		name: "filtered task scan (50)",
		async run(storage) {
			return (
				await storage.scanTasks(
					{ kind: "benchmark.filtered", status: "pending", background: true },
					undefined,
					50,
					BACKGROUND_CONTEXT,
				)
			).items.length;
		},
		expected: ({ filteredTaskCount }) => filteredTaskCount,
	},
	{
		name: "exact document address among many",
		async run(storage, dataset) {
			return (
				(
					await storage.findDocument(
						{ kind: "benchmark.family", key: dataset.exactDocumentKey, scope: { kind: "session" } },
						"current",
						BACKGROUND_CONTEXT,
					)
				)?.id ?? -1
			);
		},
		expected: ({ exactDocumentId }) => exactDocumentId,
	},
	...REPLAY_TAILS.map(
		(tail): StorageReadBenchmark => ({
			name: `document replay tail (${tail})`,
			async run(storage, dataset) {
				return Number(
					(await storage.document(dataset.replayDocumentIds[tail], "current", BACKGROUND_CONTEXT))?.value.count,
				);
			},
			expected: () => tail,
		}),
	),
	{
		name: "ancient historical read before newer base",
		async run(storage, dataset) {
			return Number(
				(await storage.document(dataset.historicalDocumentId, dataset.ancientAt, BACKGROUND_CONTEXT))?.value.count,
			);
		},
		expected: () => HISTORY_SEGMENT_LENGTH,
	},
	{
		name: "recent historical read after newer base",
		async run(storage, dataset) {
			return Number(
				(await storage.document(dataset.historicalDocumentId, dataset.recentAt, BACKGROUND_CONTEXT))?.value.count,
			);
		},
		expected: () => HISTORY_SEGMENT_LENGTH * 2,
	},
	{
		name: "fork-depth history scan (100)",
		async run(storage, dataset) {
			return (
				await storage.scanEntries(
					{ conversationId: dataset.deepestConversationId },
					undefined,
					100,
					BACKGROUND_CONTEXT,
				)
			).items.length;
		},
		expected: () => 100,
	},
	{
		name: "fork-depth head lookup",
		async run(storage, dataset) {
			return (
				(await storage.findLatestHeadMarker(dataset.deepestConversationId, undefined, BACKGROUND_CONTEXT))?.id ?? -1
			);
		},
		expected: ({ ancestorHeadEntryId }) => ancestorHeadEntryId,
	},
];

export type StorageWriteBenchmark = {
	readonly name: string;
	readonly expected: number;
	run(storage: Storage): Promise<number>;
};

/** Seed the common state expected by every write benchmark sample. */
export async function seedStorageWriteBenchmark(storage: Storage): Promise<void> {
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
	await storage.commit(
		await Promise.all(
			Array.from({ length: 100 }, async (_, index) => ({
				type: "entry" as const,
				value: {
					id: await storage.mintId(),
					conversationId: ROOT_CONVERSATION_ID,
					kind: "benchmark.baseline",
					data: { index },
				},
			})),
		),
		BACKGROUND_CONTEXT,
	);
}

export const STORAGE_WRITE_BENCHMARKS: readonly StorageWriteBenchmark[] = [
	{
		name: "commit one entry",
		expected: 1,
		async run(storage) {
			const id = await storage.mintId();
			await storage.commit(
				[
					{
						type: "entry",
						value: {
							id,
							conversationId: ROOT_CONVERSATION_ID,
							kind: "benchmark.write",
							data: { text: "x".repeat(128) },
						},
					},
				],
				BACKGROUND_CONTEXT,
			);
			return 1;
		},
	},
	{
		name: "commit 100 entries",
		expected: 100,
		async run(storage) {
			const writes = await Promise.all(
				Array.from(
					{ length: 100 },
					async (_, index): Promise<StorageWrite> => ({
						type: "entry",
						value: {
							id: await storage.mintId(),
							conversationId: ROOT_CONVERSATION_ID,
							kind: "benchmark.write",
							data: { index, text: "x".repeat(128) },
						},
					}),
				),
			);
			await storage.commit(writes, BACKGROUND_CONTEXT);
			return writes.length;
		},
	},
	{
		name: "commit mixed entry/task/submission/document",
		expected: 4,
		async run(storage) {
			const entryId = await storage.mintId();
			const taskId = await storage.mintId();
			const submissionId = await storage.mintId();
			const documentId = await storage.mintId();
			const writes: readonly StorageWrite[] = [
				{
					type: "entry",
					value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "benchmark.mixed" },
				},
				{ type: "task", value: task(taskId, taskId) },
				{
					type: "submission",
					value: {
						id: submissionId,
						conversationId: ROOT_CONVERSATION_ID,
						requestId: `benchmark-${submissionId}`,
						type: "write",
						status: "done",
						entry: entryId,
					},
				},
				{
					type: "document.create",
					record: { id: documentId, kind: "benchmark.mixed", key: String(documentId), scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { entryId, taskId } },
				},
			];
			await storage.commit(writes, BACKGROUND_CONTEXT);
			return writes.length;
		},
	},
];
