import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type EffectiveLaneConfiguration,
	type LaneReductionInput,
	RecordLogCorruption,
	type RecordLogCorruptionReason,
	type RecordLogSlice,
	reduceLaneState,
	validateRecordLog,
} from "../../src/harness/reducer.ts";
import type {
	AbortRequestedRecord,
	BranchSummaryEntry,
	CompactionEntry,
	Entry,
	LaneRecord,
	MessageEntry,
	OperationFinishedRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	QueueCancelledRecord,
	QueueEnqueuedRecord,
	SessionStopReason,
	StepAttemptRecord,
	ToolStartedRecord,
	UsageRecord,
	WriteDeferredRecord,
} from "../../src/harness/session/types.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason,
		timestamp: 1,
		...(stopReason === "deferred"
			? { deferred: { provider: "openai", modelId: "test-model", api: "openai-responses", id: "deferred-1" } }
			: {}),
	};
}

function toolResultMessage(toolCallId = "call-1", toolName = "tool-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 1,
	};
}

function messageTarget(
	id: string,
	message: UserMessage | AssistantMessage | ToolResultMessage,
): ProvisionedEntry<MessageEntry> {
	return { type: "message", id, message };
}

function persistedEntry<TEntry extends Entry>(
	target: ProvisionedEntry<TEntry>,
	seq: number,
	parentId: string | null = null,
): TEntry {
	return { ...target, parentId, seq, timestamp: seq } as unknown as TEntry;
}

function runStarted(
	seq = 1,
	options: { id?: string; initialMessages?: ProvisionedEntry[] } = {},
): OperationStartedRecord {
	return {
		type: "operation_started",
		id: options.id ?? "run-1",
		lane: "main",
		seq,
		timestamp: seq,
		sourceLeafId: null,
		intent: { kind: "run", originalPrompt: [], initialMessages: options.initialMessages ?? [] },
	};
}

function compactionStarted(seq: number, resultEntryId = "compaction-1"): OperationStartedRecord {
	return {
		type: "operation_started",
		id: "compact-1",
		lane: "main",
		seq,
		timestamp: seq,
		sourceLeafId: "source",
		intent: { kind: "compaction", resultEntryId },
	};
}

function navigationStarted(seq: number, summaryEntryId = "summary-1"): OperationStartedRecord {
	return {
		type: "operation_started",
		id: "navigate-1",
		lane: "main",
		seq,
		timestamp: seq,
		sourceLeafId: "source",
		intent: { kind: "navigation", targetId: "target", summarize: true, summaryEntryId },
	};
}

function attempt(
	seq: number,
	runId: string,
	step: StepAttemptRecord["step"],
	attemptNumber: number,
	resultEntryId: string,
	compactionReason?: "manual" | "threshold" | "overflow",
): StepAttemptRecord {
	const base = {
		type: "step_attempt" as const,
		id: `attempt-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		runId,
		attempt: attemptNumber,
		resultEntryId,
	};
	return step === "compaction" ? { ...base, step, compactionReason: compactionReason ?? "manual" } : { ...base, step };
}

function abortRequested(seq: number, runId = "run-1"): AbortRequestedRecord {
	return { type: "abort_requested", id: `abort-${seq}`, lane: "main", seq, timestamp: seq, runId };
}

function operationFinished(
	seq: number,
	runId = "run-1",
	outcome: OperationFinishedRecord["outcome"] = "completed",
): OperationFinishedRecord {
	return { type: "operation_finished", id: `finish-${seq}`, lane: "main", seq, timestamp: seq, runId, outcome };
}

function toolStarted(
	seq: number,
	overrides: Partial<
		Pick<ToolStartedRecord, "assistantEntryId" | "toolIndex" | "toolCallId" | "toolName" | "resultEntryId">
	> = {},
): ToolStartedRecord {
	return {
		type: "tool_started",
		id: `tool-start-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		runId: "run-1",
		assistantEntryId: overrides.assistantEntryId ?? "assistant-tools",
		toolIndex: overrides.toolIndex ?? 0,
		toolCallId: overrides.toolCallId ?? "call-1",
		toolName: overrides.toolName ?? "tool-1",
		effectiveArgs: {},
		resultEntryId: overrides.resultEntryId ?? "tool-result-1",
		replay: "never",
	};
}

function queueEnqueued(
	seq: number,
	target: ProvisionedEntry = messageTarget("queue-1", userMessage("queued")),
	queue: QueueEnqueuedRecord["queue"] = "steer",
): QueueEnqueuedRecord {
	const base = { type: "queue_enqueued" as const, id: `queue-${seq}`, lane: "main", seq, timestamp: seq, target };
	return queue === "nextRun" ? { ...base, queue } : { ...base, queue, runId: "run-1" };
}

function queueCancelled(seq: number, entryId = "queue-1", runId: string | null = "run-1"): QueueCancelledRecord {
	return {
		type: "queue_cancelled",
		id: `cancel-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		entryId,
		...(runId === null ? {} : { runId }),
	};
}

function writeDeferred(
	seq: number,
	target: ProvisionedEntry = messageTarget("write-1", userMessage("deferred write")),
): WriteDeferredRecord {
	return { type: "write_deferred", id: `write-${seq}`, lane: "main", seq, timestamp: seq, runId: "run-1", target };
}

function usageRecord(
	seq: number,
	resultEntryId: string,
	stopReason: SessionStopReason = "error",
	attemptNumber = 1,
): UsageRecord {
	return {
		type: "usage",
		id: `usage-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		cause: "assistant",
		runId: "run-1",
		entryId: resultEntryId,
		attempt: attemptNumber,
		stopReason,
		usage,
	};
}

function compactionEntry(id: string, seq: number): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		seq,
		timestamp: seq,
		summary: "summary",
		retainedTail: [],
		tokensBefore: 10,
	};
}

function branchSummaryEntry(id: string, seq: number): BranchSummaryEntry {
	return {
		type: "branch_summary",
		id,
		parentId: "target",
		seq,
		timestamp: seq,
		fromId: "source",
		summary: "summary",
	};
}

function recoverySlice(records: readonly LaneRecord[], entries: readonly Entry[] = []): RecordLogSlice {
	const finished = new Set(
		records
			.filter((record): record is OperationFinishedRecord => record.type === "operation_finished")
			.map((record) => record.runId),
	);
	const openOperations = records
		.filter(
			(record): record is OperationStartedRecord => record.type === "operation_started" && !finished.has(record.id),
		)
		.sort((left, right) => right.seq - left.seq);
	return { lane: "main", openOperations, records, entries };
}

const defaults: EffectiveLaneConfiguration = {
	model: { provider: "default-provider", modelId: "default-model" },
	thinkingLevel: "off",
	activeToolNames: ["default-tool"],
};

function reductionInput(
	records: readonly LaneRecord[],
	ownEntries: readonly Entry[] = [],
	options: {
		entries?: readonly Entry[];
		configurationEntries?: readonly Entry[];
		leafId?: string | null;
		defaults?: EffectiveLaneConfiguration;
	} = {},
): LaneReductionInput {
	const slice = recoverySlice(records, [...ownEntries, ...(options.entries ?? [])]);
	return {
		...slice,
		leafId: options.leafId === undefined ? (ownEntries.at(-1)?.id ?? null) : options.leafId,
		ownEntries,
		configurationEntries: options.configurationEntries ?? [],
		defaults: options.defaults ?? defaults,
	};
}

function expectCorruption(input: RecordLogSlice, reason: RecordLogCorruptionReason): void {
	try {
		validateRecordLog(input);
		expect.fail(`Expected ${reason}`);
	} catch (error) {
		expect(error).toBeInstanceOf(RecordLogCorruption);
		expect(error).toMatchObject({ reason });
	}
}

const assistantToolsEntry = persistedEntry(
	messageTarget(
		"assistant-tools",
		assistantMessage([{ type: "toolCall", id: "call-1", name: "tool-1", arguments: {} }], "toolUse"),
	),
	3,
);

interface CorruptionCase {
	name: string;
	reason: RecordLogCorruptionReason;
	input: RecordLogSlice;
}

const corruptionCases: CorruptionCase[] = [
	{
		name: "multiple operations are open",
		reason: "multiple_open_operations",
		input: recoverySlice([runStarted(1), runStarted(2, { id: "run-2" })]),
	},
	{
		name: "a record references an operation that does not exist",
		reason: "unknown_operation",
		input: recoverySlice([abortRequested(1, "missing")]),
	},
	{
		name: "a record follows its operation finish",
		reason: "record_after_finish",
		input: recoverySlice([runStarted(1), operationFinished(2), abortRequested(3)]),
	},
	{
		name: "attempt numbers skip within one assistant step",
		reason: "non_consecutive_attempt",
		input: recoverySlice([
			runStarted(1),
			attempt(2, "run-1", "assistant", 1, "assistant-1"),
			attempt(3, "run-1", "assistant", 3, "assistant-2"),
		]),
	},
	{
		name: "a non-compaction attempt carries compactionReason",
		reason: "invalid_compaction_reason",
		input: recoverySlice([
			runStarted(1),
			{ ...attempt(2, "run-1", "assistant", 1, "assistant-1"), compactionReason: "manual" } as unknown as LaneRecord,
		]),
	},
	{
		name: "a compaction attempt omits compactionReason",
		reason: "invalid_compaction_reason",
		input: recoverySlice([
			runStarted(1),
			{
				...attempt(2, "run-1", "compaction", 1, "compaction-1"),
				compactionReason: undefined,
			} as unknown as LaneRecord,
		]),
	},
	{
		name: "steering is enqueued after abort",
		reason: "queue_after_abort",
		input: recoverySlice([runStarted(1), abortRequested(2), queueEnqueued(3)]),
	},
	{
		name: "a queue cancellation has no enqueue",
		reason: "invalid_queue_cancellation",
		input: recoverySlice([runStarted(1), queueCancelled(2)]),
	},
	{
		name: "a queue cancellation targets an entry that exists",
		reason: "invalid_queue_cancellation",
		input: recoverySlice(
			[runStarted(1), queueEnqueued(2), queueCancelled(4)],
			[persistedEntry(messageTarget("queue-1", userMessage("queued")), 3)],
		),
	},
	{
		name: "structural attempts disagree on resultEntryId",
		reason: "inconsistent_step",
		input: recoverySlice([
			runStarted(1),
			attempt(2, "run-1", "compaction", 1, "compaction-1", "threshold"),
			attempt(3, "run-1", "compaction", 2, "compaction-2", "threshold"),
		]),
	},
	{
		name: "structural attempts disagree on compactionReason",
		reason: "inconsistent_step",
		input: recoverySlice([
			runStarted(1),
			attempt(2, "run-1", "compaction", 1, "compaction-1", "threshold"),
			attempt(3, "run-1", "compaction", 2, "compaction-1", "overflow"),
		]),
	},
	{
		name: "tool_started does not match the assistant tool call",
		reason: "tool_call_mismatch",
		input: recoverySlice([runStarted(1), toolStarted(4, { toolCallId: "different-call" })], [assistantToolsEntry]),
	},
	{
		name: "two tool_started records share an invocation identity",
		reason: "duplicate_tool_invocation",
		input: recoverySlice(
			[
				runStarted(1),
				toolStarted(4),
				{ ...toolStarted(5, { resultEntryId: "tool-result-2" }), id: "tool-start-duplicate" },
			],
			[assistantToolsEntry],
		),
	},
	{
		name: "a provisioned id exists with different content",
		reason: "provisioned_entry_mismatch",
		input: recoverySlice(
			[runStarted(1, { initialMessages: [messageTarget("prompt-1", userMessage("expected"))] })],
			[persistedEntry(messageTarget("prompt-1", userMessage("different")), 2)],
		),
	},
	{
		name: "a deferred assistant message has no handle",
		reason: "invalid_deferred_handle",
		input: recoverySlice(
			[runStarted(1)],
			[
				persistedEntry(
					messageTarget("assistant-deferred", { ...assistantMessage([], "deferred"), deferred: undefined }),
					2,
				),
			],
		),
	},
];

describe("record-log validity", () => {
	it.each(corruptionCases)("rejects $name", ({ input, reason }) => {
		expectCorruption(input, reason);
	});

	it("does not mutate its bounded recovery inputs", () => {
		const target = messageTarget("prompt-1", userMessage("hello"));
		const start = Object.freeze(runStarted(1, { initialMessages: [target] }));
		const entry = Object.freeze(persistedEntry(target, 2));
		const input = Object.freeze({
			lane: "main",
			openOperations: Object.freeze([start]),
			records: Object.freeze([start]),
			entries: Object.freeze([entry]),
		});

		expect(validateRecordLog(input)).toBeUndefined();
		expect(input.records).toEqual([start]);
		expect(input.entries).toEqual([entry]);
	});
});

type DurableAction = { record: LaneRecord } | { entry: Entry };

function validPrefixes(trace: string, actions: readonly DurableAction[]): { name: string; input: RecordLogSlice }[] {
	return actions.map((_, index) => {
		const prefix = actions.slice(0, index + 1);
		return {
			name: `${trace} after action ${index + 1}`,
			input: recoverySlice(
				prefix.flatMap((action) => ("record" in action ? [action.record] : [])),
				prefix.flatMap((action) => ("entry" in action ? [action.entry] : [])),
			),
		};
	});
}

const promptTarget = messageTarget("prompt-1", userMessage("fix the bug"));
const assistantToolTarget = messageTarget(
	"assistant-tools",
	assistantMessage([{ type: "toolCall", id: "call-1", name: "tool-1", arguments: {} }], "toolUse"),
);
const toolResultTarget = messageTarget("tool-result-1", toolResultMessage());
const assistantFinalTarget = messageTarget("assistant-final", assistantMessage([{ type: "text", text: "done" }]));

const validPrefixCases = [
	...validPrefixes("one-tool run X1-X5", [
		{ record: runStarted(1, { initialMessages: [promptTarget] }) },
		{ entry: persistedEntry(promptTarget, 2) },
		{ record: attempt(3, "run-1", "assistant", 1, "assistant-tools") },
		{ entry: persistedEntry(assistantToolTarget, 4, "prompt-1") },
		{ record: toolStarted(5) },
		{ entry: persistedEntry(toolResultTarget, 6, "assistant-tools") },
		{ record: attempt(7, "run-1", "assistant", 1, "assistant-final") },
		{ entry: persistedEntry(assistantFinalTarget, 8, "tool-result-1") },
		{ record: operationFinished(9) },
	]),
	...validPrefixes("assistant retry", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-attempt-1") },
		{ record: usageRecord(3, "assistant-attempt-1") },
		{ record: attempt(4, "run-1", "assistant", 2, "assistant-attempt-2") },
		{ record: usageRecord(5, "assistant-attempt-2", "stop", 2) },
		{
			entry: persistedEntry(
				messageTarget("assistant-attempt-2", assistantMessage([{ type: "text", text: "ok" }])),
				6,
			),
		},
	]),
	...validPrefixes("terminal assistant failure", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-error") },
		{
			entry: persistedEntry(
				messageTarget("assistant-error", { ...assistantMessage([], "error"), errorMessage: "failed" }),
				3,
			),
		},
		{ record: operationFinished(4, "run-1", "failed") },
	]),
	...validPrefixes("overflow compaction and retry", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "discarded-overflow") },
		{ record: usageRecord(3, "discarded-overflow", "length") },
		{ record: attempt(4, "run-1", "compaction", 1, "overflow-compaction", "overflow") },
		{ entry: compactionEntry("overflow-compaction", 5) },
		{ record: attempt(6, "run-1", "assistant", 1, "assistant-after-compaction") },
		{
			entry: persistedEntry(
				messageTarget("assistant-after-compaction", assistantMessage([{ type: "text", text: "fits" }])),
				7,
			),
		},
	]),
	...validPrefixes("steering acceptance and consumption", [
		{ record: runStarted(1) },
		{ record: queueEnqueued(2) },
		{ entry: persistedEntry(messageTarget("queue-1", userMessage("queued")), 3) },
	]),
	...validPrefixes("queue cancellation", [
		{ record: runStarted(1) },
		{ record: queueEnqueued(2) },
		{ record: queueCancelled(3) },
	]),
	...validPrefixes("deferred write acceptance and application", [
		{ record: runStarted(1) },
		{ record: writeDeferred(2) },
		{ entry: persistedEntry(messageTarget("write-1", userMessage("deferred write")), 3) },
	]),
	...validPrefixes("abort during a tool", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-tools") },
		{ entry: persistedEntry(assistantToolTarget, 3) },
		{ record: toolStarted(4) },
		{ record: abortRequested(5) },
		{
			entry: persistedEntry(
				messageTarget("tool-result-1", {
					...toolResultMessage(),
					content: [{ type: "text", text: "interrupted" }],
					isError: true,
				}),
				6,
			),
		},
	]),
	...validPrefixes("threshold auto-compaction", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "compaction", 1, "threshold-compaction", "threshold") },
		{ entry: compactionEntry("threshold-compaction", 3) },
		{ record: attempt(4, "run-1", "assistant", 1, "assistant-after-threshold") },
	]),
	...validPrefixes("manual compaction", [
		{ record: compactionStarted(1) },
		{ record: attempt(2, "compact-1", "compaction", 1, "compaction-1", "manual") },
		{ entry: compactionEntry("compaction-1", 3) },
		{ record: operationFinished(4, "compact-1") },
	]),
	...validPrefixes("move-first navigation summary", [
		{ record: navigationStarted(1) },
		{ record: attempt(2, "navigate-1", "branch_summary", 1, "summary-1") },
		{ entry: branchSummaryEntry("summary-1", 3) },
		{ record: operationFinished(4, "navigate-1") },
	]),
	...validPrefixes("blocked tool without an intent record", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-tools") },
		{ entry: persistedEntry(assistantToolTarget, 3) },
		{
			entry: persistedEntry(
				messageTarget("blocked-result", {
					...toolResultMessage(),
					content: [{ type: "text", text: "blocked" }],
					isError: true,
				}),
				4,
			),
		},
	]),
	...validPrefixes("idle next-run cancellation", [
		{ record: queueEnqueued(1, messageTarget("next-1", userMessage("later")), "nextRun") },
		{ record: queueCancelled(2, "next-1", null) },
	]),
	...validPrefixes("next-run enqueue after abort", [
		{ record: runStarted(1) },
		{ record: abortRequested(2) },
		{ record: queueEnqueued(3, messageTarget("next-1", userMessage("later")), "nextRun") },
	]),
	...validPrefixes("deferred write applied during abort reconciliation", [
		{ record: runStarted(1) },
		{ record: writeDeferred(2) },
		{ record: abortRequested(3) },
		{ entry: persistedEntry(messageTarget("write-1", userMessage("deferred write")), 4) },
	]),
	...validPrefixes("accepted steering killed by abort", [
		{ record: runStarted(1) },
		{ record: queueEnqueued(2) },
		{ record: abortRequested(3) },
	]),
	...validPrefixes("compaction retry", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "compaction", 1, "threshold-compaction", "threshold") },
		{ record: attempt(3, "run-1", "compaction", 2, "threshold-compaction", "threshold") },
		{ entry: compactionEntry("threshold-compaction", 4) },
	]),
	...validPrefixes("hook-supplied manual compaction", [
		{ record: compactionStarted(1) },
		{ entry: compactionEntry("compaction-1", 2) },
		{ record: operationFinished(3, "compact-1") },
	]),
	...validPrefixes("hook-supplied navigation summary", [
		{ record: navigationStarted(1) },
		{ entry: branchSummaryEntry("summary-1", 2) },
		{ record: operationFinished(3, "navigate-1") },
	]),
	...validPrefixes("deferred provider suspension and redemption", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-deferred") },
		{ entry: persistedEntry(messageTarget("assistant-deferred", assistantMessage([], "deferred")), 3) },
		{
			entry: persistedEntry(
				messageTarget("assistant-redeemed", assistantMessage([{ type: "text", text: "ready" }])),
				4,
			),
		},
	]),
	...validPrefixes("abort of a deferred provider request", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-deferred") },
		{ entry: persistedEntry(messageTarget("assistant-deferred", assistantMessage([], "deferred")), 3) },
		{ record: abortRequested(4) },
	]),
];

describe("valid section 6 durable prefixes", () => {
	it.each(validPrefixCases)("accepts $name", ({ input }) => {
		expect(validateRecordLog(input)).toBeUndefined();
	});
});

describe("lane-state reduction", () => {
	it("reduces an idle lane to pending next-run input and default configuration", () => {
		const pending = messageTarget("next-pending", userMessage("pending"));
		const cancelled = messageTarget("next-cancelled", userMessage("cancelled"));
		const consumed = messageTarget("next-consumed", userMessage("consumed"));
		const input = reductionInput(
			[
				queueEnqueued(1, pending, "nextRun"),
				queueEnqueued(2, cancelled, "nextRun"),
				queueCancelled(3, cancelled.id, null),
				queueEnqueued(4, consumed, "nextRun"),
			],
			[],
			{ entries: [persistedEntry(consumed, 5)], leafId: "idle-leaf" },
		);

		expect(reduceLaneState(input)).toEqual({
			laneState: {
				lane: "main",
				leafId: "idle-leaf",
				operation: null,
				pendingNextRun: [pending],
			},
			effectiveConfiguration: defaults,
			terminalFailure: null,
		});
	});

	it("folds persisted configuration over copied defaults in sequence", () => {
		const configurationEntries: Entry[] = [
			{
				type: "model_change",
				id: "model-change",
				parentId: null,
				seq: 1,
				timestamp: 1,
				provider: "persisted-provider",
				modelId: "persisted-model",
			},
			{
				type: "thinking_level_change",
				id: "thinking-change",
				parentId: "model-change",
				seq: 2,
				timestamp: 2,
				thinkingLevel: "high",
			},
			{
				type: "active_tools_change",
				id: "tools-change",
				parentId: "thinking-change",
				seq: 3,
				timestamp: 3,
				activeToolNames: ["persisted-tool"],
			},
		];
		const input = reductionInput([], [], { configurationEntries });

		expect(reduceLaneState(input).effectiveConfiguration).toEqual({
			model: { provider: "persisted-provider", modelId: "persisted-model" },
			thinkingLevel: "high",
			activeToolNames: ["persisted-tool"],
		});
		expect(input.defaults).toEqual(defaults);
	});

	it("applies committed operation-owned configuration after the anchor", () => {
		const assistant = persistedEntry(
			messageTarget("assistant-config", {
				...assistantMessage([{ type: "text", text: "response" }]),
				provider: "response-provider",
				model: "response-model",
			}),
			2,
		);
		const tools: Entry = {
			type: "active_tools_change",
			id: "operation-tools",
			parentId: assistant.id,
			seq: 3,
			timestamp: 3,
			activeToolNames: ["operation-tool"],
		};
		const result = reduceLaneState(reductionInput([runStarted(1)], [assistant, tools]));

		expect(result.effectiveConfiguration).toEqual({
			model: { provider: "response-provider", modelId: "response-model" },
			thinkingLevel: "off",
			activeToolNames: ["operation-tool"],
		});
	});

	it("keeps captured next-run input with the open run instead of pending next-run", () => {
		const captured = messageTarget("next-captured", userMessage("captured"));
		const later = messageTarget("next-later", userMessage("later"));
		const start = runStarted(2, { initialMessages: [captured] });

		const result = reduceLaneState(
			reductionInput([queueEnqueued(1, captured, "nextRun"), start, queueEnqueued(3, later, "nextRun")]),
		);

		expect(result.laneState.pendingNextRun).toEqual([later]);
		expect(result.laneState.operation?.missingInitialMessages).toEqual([captured]);
	});

	it("derives missing input, queues, deferred writes, and the unfinished attempt", () => {
		const missingPrompt = messageTarget("prompt-missing", userMessage("missing"));
		const committedPrompt = messageTarget("prompt-committed", userMessage("committed"));
		const steer = messageTarget("steer-pending", userMessage("steer"));
		const consumedFollowUp = messageTarget("follow-consumed", userMessage("follow"));
		const nextRun = messageTarget("next-run", userMessage("next"));
		const pendingWrite = messageTarget("write-pending", userMessage("write"));
		const appliedWrite = messageTarget("write-applied", userMessage("applied"));
		const start = runStarted(1, { initialMessages: [missingPrompt, committedPrompt] });
		const committedPromptEntry = persistedEntry(committedPrompt, 2);
		const consumedFollowUpEntry = persistedEntry(consumedFollowUp, 6, committedPrompt.id);
		const appliedWriteEntry = persistedEntry(appliedWrite, 9, consumedFollowUp.id);
		const input = reductionInput(
			[
				start,
				queueEnqueued(3, steer),
				queueEnqueued(4, consumedFollowUp, "followUp"),
				queueEnqueued(5, nextRun, "nextRun"),
				writeDeferred(7, pendingWrite),
				writeDeferred(8, appliedWrite),
				attempt(10, start.id, "assistant", 1, "assistant-pending"),
			],
			[committedPromptEntry, consumedFollowUpEntry, appliedWriteEntry],
		);

		const result = reduceLaneState(input);
		expect(result.laneState.pendingNextRun).toEqual([nextRun]);
		expect(result.laneState.operation).toMatchObject({
			id: start.id,
			kind: "run",
			aborting: false,
			missingInitialMessages: [missingPrompt],
			pendingSteer: [steer],
			pendingFollowUp: [],
			pendingWrites: [pendingWrite],
			step: { kind: "assistant", attempts: 1, resultEntryId: "assistant-pending" },
			newestOwn: { entryId: appliedWrite.id, type: "message", role: "user" },
		});
	});

	it("kills steer and follow-up queues on abort while preserving writes and next-run input", () => {
		const steer = messageTarget("steer-aborted", userMessage("steer"));
		const followUp = messageTarget("follow-aborted", userMessage("follow"));
		const nextRun = messageTarget("next-after-abort", userMessage("next"));
		const pendingWrite = messageTarget("write-after-abort", userMessage("write"));
		const input = reductionInput([
			runStarted(1),
			queueEnqueued(2, steer),
			queueEnqueued(3, followUp, "followUp"),
			queueEnqueued(4, nextRun, "nextRun"),
			writeDeferred(5, pendingWrite),
			abortRequested(6),
		]);

		const result = reduceLaneState(input);
		expect(result.laneState.pendingNextRun).toEqual([nextRun]);
		expect(result.laneState.operation).toMatchObject({
			aborting: true,
			pendingSteer: [],
			pendingFollowUp: [],
			pendingWrites: [pendingWrite],
		});
	});

	it.each([
		{
			name: "assistant",
			record: attempt(2, "run-1", "assistant", 1, "result"),
			expected: { kind: "assistant", attempts: 1, resultEntryId: "result" },
		},
		{
			name: "compaction",
			record: attempt(2, "run-1", "compaction", 1, "result", "overflow"),
			expected: {
				kind: "compaction",
				attempts: 1,
				resultEntryId: "result",
				compactionReason: "overflow",
			},
		},
		{
			name: "branch summary",
			record: attempt(2, "run-1", "branch_summary", 1, "result"),
			expected: { kind: "branch_summary", attempts: 1, resultEntryId: "result" },
		},
	])("reduces an unfinished $name step", ({ record, expected }) => {
		const result = reduceLaneState(reductionInput([runStarted(1), record]));
		expect(result.laneState.operation?.step).toEqual(expected);
	});

	it("closes the newest attempt only when its provisioned result exists", () => {
		const target = messageTarget("result", assistantMessage([{ type: "text", text: "done" }]));
		const result = reduceLaneState(
			reductionInput([runStarted(1), attempt(2, "run-1", "assistant", 1, target.id)], [persistedEntry(target, 3)]),
		);
		expect(result.laneState.operation?.step).toBeNull();
	});

	it("ignores unfulfilled result ids from earlier attempts", () => {
		const target = messageTarget("attempt-2-result", assistantMessage([{ type: "text", text: "done" }]));
		const result = reduceLaneState(
			reductionInput(
				[
					runStarted(1),
					attempt(2, "run-1", "assistant", 1, "attempt-1-result"),
					attempt(3, "run-1", "assistant", 2, target.id),
				],
				[persistedEntry(target, 4)],
			),
		);
		expect(result.laneState.operation?.step).toBeNull();
	});

	it.each([
		{ name: "X1", records: [runStarted(1), attempt(2, "run-1", "assistant", 1, "assistant-tools")] },
		{
			name: "X3",
			records: [runStarted(1), attempt(2, "run-1", "assistant", 1, "assistant-tools"), toolStarted(4)],
		},
		{
			name: "X5",
			records: [runStarted(1), attempt(2, "run-1", "assistant", 1, "assistant-tools"), toolStarted(4)],
			result: { ...persistedEntry(toolResultTarget, 5, assistantToolsEntry.id), terminate: true as const },
		},
	])("reduces tool batch state at $name", ({ records, result }) => {
		const ownEntries = result ? [assistantToolsEntry, result] : [assistantToolsEntry];
		const reduction = reduceLaneState(reductionInput(records, ownEntries));
		const call = reduction.laneState.operation?.toolBatch?.calls[0];

		expect(reduction.laneState.operation?.toolBatch).toMatchObject({
			assistantEntryId: assistantToolsEntry.id,
			truncated: false,
			unresolved: !result,
		});
		expect(call).toMatchObject({
			toolIndex: 0,
			toolCall: { id: "call-1", name: "tool-1" },
			resultExists: result !== undefined,
			...(result ? { terminate: true } : {}),
		});
		expect(call?.started !== undefined).toBe(records.some((record) => record.type === "tool_started"));
	});

	it("does not resolve a tool batch from a deferred-write tool result", () => {
		const assistant = persistedEntry(assistantToolTarget, 3);
		const writtenResult = messageTarget("written-tool-result", toolResultMessage());
		const result = reduceLaneState(
			reductionInput(
				[runStarted(1), attempt(2, "run-1", "assistant", 1, assistant.id), writeDeferred(4, writtenResult)],
				[assistant, persistedEntry(writtenResult, 5, assistant.id)],
			),
		);

		expect(result.laneState.operation?.toolBatch?.calls[0]).toMatchObject({ resultExists: false });
		expect(result.laneState.operation?.toolBatch?.unresolved).toBe(true);
	});

	it("matches blocked results without tool-start records and preserves source order", () => {
		const assistant = persistedEntry(
			messageTarget(
				"assistant-two-tools",
				assistantMessage(
					[
						{ type: "toolCall", id: "call-1", name: "tool-1", arguments: {} },
						{ type: "toolCall", id: "call-2", name: "tool-2", arguments: {} },
					],
					"toolUse",
				),
			),
			3,
		);
		const blocked = persistedEntry(
			messageTarget("blocked-result", {
				...toolResultMessage("call-1", "tool-1"),
				content: [{ type: "text", text: "blocked" }],
				isError: true,
			}),
			4,
			assistant.id,
		);
		const secondStart = toolStarted(5, {
			assistantEntryId: assistant.id,
			toolIndex: 1,
			toolCallId: "call-2",
			toolName: "tool-2",
			resultEntryId: "call-2-result",
		});
		const result = reduceLaneState(
			reductionInput(
				[runStarted(1), attempt(2, "run-1", "assistant", 1, assistant.id), secondStart],
				[assistant, blocked],
			),
		);

		expect(result.laneState.operation?.toolBatch?.calls).toMatchObject([
			{ toolIndex: 0, toolCall: { id: "call-1" }, resultExists: true },
			{ toolIndex: 1, toolCall: { id: "call-2" }, started: secondStart, resultExists: false },
		]);
	});

	it("marks a length-stopped tool batch as truncated without resolving it", () => {
		const truncated = persistedEntry(
			messageTarget(
				"assistant-truncated",
				assistantMessage([{ type: "toolCall", id: "call-1", name: "tool-1", arguments: {} }], "length"),
			),
			3,
		);
		const result = reduceLaneState(
			reductionInput([runStarted(1), attempt(2, "run-1", "assistant", 1, truncated.id)], [truncated]),
		);
		expect(result.laneState.operation?.toolBatch).toMatchObject({ truncated: true, unresolved: true });
	});

	it("detects an unredeemed deferred handle only at the operation tail", () => {
		const deferredMessage = assistantMessage([], "deferred");
		const deferredEntry = persistedEntry(messageTarget("assistant-deferred", deferredMessage), 3);
		const pending = reduceLaneState(
			reductionInput([runStarted(1), attempt(2, "run-1", "assistant", 1, deferredEntry.id)], [deferredEntry]),
		);
		expect(pending.laneState.operation?.deferred).toEqual(deferredMessage.deferred);

		const successor = persistedEntry(
			messageTarget("assistant-ready", assistantMessage([{ type: "text", text: "ready" }])),
			4,
			deferredEntry.id,
		);
		const redeemed = reduceLaneState(
			reductionInput(
				[runStarted(1), attempt(2, "run-1", "assistant", 1, deferredEntry.id)],
				[deferredEntry, successor],
			),
		);
		expect(redeemed.laneState.operation?.deferred).toBeNull();
	});

	it.each([
		{
			name: "step",
			records: [runStarted(1), attempt(2, "run-1", "assistant", 1, "assistant-error")],
			ownEntries: [
				persistedEntry(
					messageTarget("assistant-error", { ...assistantMessage([], "error"), errorMessage: "failed" }),
					3,
				),
			],
			expectedSource: "step",
		},
		{
			name: "deferred fetch",
			records: [runStarted(1), attempt(2, "run-1", "assistant", 1, "assistant-deferred")],
			ownEntries: [
				persistedEntry(messageTarget("assistant-deferred", assistantMessage([], "deferred")), 3),
				persistedEntry(
					messageTarget("deferred-error", { ...assistantMessage([], "error"), errorMessage: "expired" }),
					4,
					"assistant-deferred",
				),
			],
			expectedSource: "deferred_fetch",
		},
		{
			name: "deferred fetch usage record",
			records: [
				runStarted(1),
				{
					type: "usage",
					id: "deferred-usage",
					lane: "main",
					seq: 3,
					timestamp: 3,
					cause: "deferred_fetch",
					runId: "run-1",
					entryId: "deferred-error",
					attempt: 1,
					stopReason: "error",
					usage,
				} satisfies UsageRecord,
			],
			ownEntries: [
				persistedEntry(
					messageTarget("deferred-error", { ...assistantMessage([], "error"), errorMessage: "expired" }),
					2,
				),
			],
			expectedSource: "deferred_fetch",
		},
	])("derives $name terminal-failure provenance", ({ records, ownEntries, expectedSource }) => {
		const result = reduceLaneState(reductionInput(records, ownEntries));
		expect(result.terminalFailure).toMatchObject({ source: expectedSource });
	});

	it("does not classify an error-shaped deferred write as terminal failure", () => {
		const target = messageTarget("written-error", { ...assistantMessage([], "error"), errorMessage: "note" });
		const entry = persistedEntry(target, 3);
		const result = reduceLaneState(reductionInput([runStarted(1), writeDeferred(2, target)], [entry]));
		expect(result.terminalFailure).toBeNull();
	});

	it.each([
		{
			name: "manual compaction result",
			records: [compactionStarted(1)],
			entries: [] as Entry[],
			expected: { result: false },
		},
		{
			name: "completed manual compaction result",
			records: [compactionStarted(1)],
			entries: [compactionEntry("compaction-1", 2)],
			expected: { result: true },
		},
		{
			name: "missing navigation summary",
			records: [navigationStarted(1)],
			entries: [] as Entry[],
			expected: { summary: false },
		},
		{
			name: "navigation summary",
			records: [navigationStarted(1)],
			entries: [branchSummaryEntry("summary-1", 2)],
			expected: { summary: true },
		},
	])("derives structural target state for $name", ({ records, entries, expected }) => {
		const result = reduceLaneState(reductionInput(records, entries));
		expect(result.laneState.operation?.targets).toEqual(expected);
	});

	it("resets the overflow guard only after newer conversational input is consumed", () => {
		const initial = messageTarget("initial", userMessage("initial"));
		const steer = messageTarget("steer", userMessage("steer"));
		const start = runStarted(1, { initialMessages: [initial] });
		const initialEntry = persistedEntry(initial, 2);
		const records: LaneRecord[] = [
			start,
			attempt(3, start.id, "compaction", 1, "overflow-summary", "overflow"),
			queueEnqueued(5, steer),
		];

		const used = reduceLaneState(reductionInput(records, [initialEntry]));
		expect(used.laneState.operation?.overflowRecoveryUsed).toBe(true);

		const reset = reduceLaneState(reductionInput(records, [initialEntry, persistedEntry(steer, 6, initial.id)]));
		expect(reset.laneState.operation?.overflowRecoveryUsed).toBe(false);
	});

	it("is deterministic and does not mutate or alias its inputs", () => {
		const pending = messageTarget("next", userMessage("next"));
		const input = reductionInput([queueEnqueued(1, pending, "nextRun")]);
		const before = structuredClone(input);
		const first = reduceLaneState(input);
		const second = reduceLaneState(input);

		expect(first).toEqual(second);
		expect(input).toEqual(before);
		first.laneState.pendingNextRun[0]!.id = "mutated-output";
		expect(input.records[0]).toMatchObject({ type: "queue_enqueued", target: { id: "next" } });
	});
});
