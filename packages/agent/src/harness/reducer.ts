import type { AssistantMessage, DeferredHandle, StopReason } from "@earendil-works/pi-ai";
import { Guard } from "typebox/guard";
import type { AgentMessage, AgentToolCall, ThinkingLevel } from "../types.ts";
import type {
	Entry,
	LaneRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	QueueEnqueuedRecord,
	StepAttemptRecord,
	ToolStartedRecord,
	WriteDeferredRecord,
} from "./session/types.ts";

/**
 * Machine-readable category for a contradiction in a lane's durable recovery
 * slice. These indicate states the single-writer record protocol cannot
 * produce, not ordinary operation failures or incomplete-but-recoverable
 * intent/result prefixes. Restore must reject such states rather than repair or
 * continue it; the accompanying error message supplies human-readable detail.
 */
export type RecordLogCorruptionReason =
	| "multiple_open_operations"
	| "unknown_operation"
	| "record_after_finish"
	| "non_consecutive_attempt"
	| "invalid_compaction_reason"
	| "queue_after_abort"
	| "invalid_queue_cancellation"
	| "inconsistent_step"
	| "tool_call_mismatch"
	| "duplicate_tool_invocation"
	| "provisioned_entry_mismatch"
	| "invalid_deferred_handle";

export class RecordLogCorruption extends Error {
	readonly reason: RecordLogCorruptionReason;

	constructor(reason: RecordLogCorruptionReason, message: string) {
		super(message);
		this.name = "RecordLogCorruption";
		this.reason = reason;
	}
}

export interface RecordLogSlice {
	lane: string;
	openOperations: readonly OperationStartedRecord[];
	records: readonly LaneRecord[];
	/** Operation-owned entries plus entries fetched directly by provisioned or referenced ids. */
	entries: readonly Entry[];
}

export interface EffectiveLaneConfiguration {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

export interface TerminalFailureState {
	entryId: string;
	source: "step" | "deferred_fetch";
	message: AssistantMessage;
}

export interface ToolBatchState {
	assistantEntryId: string;
	calls: {
		toolIndex: number;
		toolCall: AgentToolCall;
		started?: ToolStartedRecord;
		resultExists: boolean;
		terminate?: boolean;
	}[];
	truncated: boolean;
	unresolved: boolean;
}

export interface LaneState {
	lane: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		intent: OperationStartedRecord["intent"];
		aborting: boolean;
		step: null | {
			kind: "assistant" | "compaction" | "branch_summary";
			attempts: number;
			resultEntryId: string;
			compactionReason?: "manual" | "threshold" | "overflow";
		};
		toolBatch: ToolBatchState | null;
		missingInitialMessages: ProvisionedEntry[];
		pendingSteer: ProvisionedEntry[];
		pendingFollowUp: ProvisionedEntry[];
		pendingWrites: ProvisionedEntry[];
		deferred: DeferredHandle | null;
		overflowRecoveryUsed: boolean;
		newestOwn: null | {
			entryId: string;
			type: Entry["type"];
			role?: AgentMessage["role"];
			stopReason?: StopReason;
		};
		targets: { result?: boolean; summary?: boolean };
	};
	pendingNextRun: ProvisionedEntry[];
}

export interface LaneReductionInput extends RecordLogSlice {
	leafId: string | null;
	/** Entries appended by the open operation, oldest first. Empty when idle. */
	ownEntries: readonly Entry[];
	/** Bounded effective-state lookups at the operation anchor or idle leaf, oldest first. */
	configurationEntries: readonly Entry[];
	/** Harness option fallbacks used when no persisted value exists. */
	defaults: EffectiveLaneConfiguration;
}

export interface LaneReductionResult {
	laneState: LaneState;
	effectiveConfiguration: EffectiveLaneConfiguration;
	terminalFailure: TerminalFailureState | null;
}

interface AttemptSeries {
	record: StepAttemptRecord;
}

function corrupt(reason: RecordLogCorruptionReason, message: string): never {
	throw new RecordLogCorruption(reason, message);
}

function hasRunId(record: LaneRecord): record is Exclude<LaneRecord, OperationStartedRecord> & { runId: string } {
	return "runId" in record && typeof record.runId === "string";
}

function matchesProvisionedEntry(entry: Entry, target: ProvisionedEntry): boolean {
	const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...payload } = entry;
	return Guard.IsDeepEqual(payload, target);
}

function validateExactProvisionedEntry(entriesById: ReadonlyMap<string, Entry>, target: ProvisionedEntry): void {
	const entry = entriesById.get(target.id);
	if (entry && !matchesProvisionedEntry(entry, target)) {
		corrupt(
			"provisioned_entry_mismatch",
			`Provisioned entry ${target.id} exists with content different from its intent`,
		);
	}
}

function validateResultEntry(
	entriesById: ReadonlyMap<string, Entry>,
	resultEntryId: string,
	matches: (entry: Entry) => boolean,
	description: string,
): void {
	const entry = entriesById.get(resultEntryId);
	if (entry && !matches(entry)) {
		corrupt(
			"provisioned_entry_mismatch",
			`Provisioned ${description} entry ${resultEntryId} exists with different content`,
		);
	}
}

function validateAttemptReason(record: StepAttemptRecord): void {
	const reason = (record as { compactionReason?: unknown }).compactionReason;
	if (record.step === "compaction") {
		if (reason !== "manual" && reason !== "threshold" && reason !== "overflow") {
			corrupt("invalid_compaction_reason", `Compaction attempt ${record.id} has no valid compaction reason`);
		}
	} else if (reason !== undefined) {
		corrupt("invalid_compaction_reason", `${record.step} attempt ${record.id} has a compaction reason`);
	}
}

function validateAttemptSequence(
	record: StepAttemptRecord,
	previous: AttemptSeries | undefined,
	entriesById: ReadonlyMap<string, Entry>,
): void {
	const previousRecord = previous?.record;
	const previousResult = previousRecord ? entriesById.get(previousRecord.resultEntryId) : undefined;
	const continuesSeries =
		previousRecord !== undefined &&
		previousRecord.step === record.step &&
		(previousResult === undefined || previousResult.seq >= record.seq);
	const expectedAttempt = continuesSeries ? previousRecord.attempt + 1 : 1;
	if (record.attempt !== expectedAttempt) {
		corrupt(
			"non_consecutive_attempt",
			`${record.step} attempt ${record.id} is ${record.attempt}; expected ${expectedAttempt}`,
		);
	}
	if (!continuesSeries || record.step === "assistant" || previousRecord === undefined) return;
	if (record.resultEntryId !== previousRecord.resultEntryId) {
		corrupt("inconsistent_step", `${record.step} attempts disagree on their result entry id`);
	}
	if (record.compactionReason !== previousRecord.compactionReason) {
		corrupt("inconsistent_step", `${record.step} attempts disagree on their compaction reason`);
	}
}

function validateAttemptResult(entriesById: ReadonlyMap<string, Entry>, record: StepAttemptRecord): void {
	switch (record.step) {
		case "assistant":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "message" && entry.message.role === "assistant",
				"assistant result",
			);
			break;
		case "compaction":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "compaction",
				"compaction result",
			);
			break;
		case "branch_summary":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "branch_summary",
				"branch-summary result",
			);
			break;
	}
}

function validateToolStart(
	record: Extract<LaneRecord, { type: "tool_started" }>,
	entriesById: ReadonlyMap<string, Entry>,
	invocations: Set<string>,
): void {
	const invocation = `${record.assistantEntryId}\u0000${record.toolIndex}`;
	if (invocations.has(invocation)) {
		corrupt(
			"duplicate_tool_invocation",
			`Tool invocation ${record.assistantEntryId}:${record.toolIndex} is duplicated`,
		);
	}
	invocations.add(invocation);

	const assistantEntry = entriesById.get(record.assistantEntryId);
	if (!assistantEntry || assistantEntry.type !== "message" || assistantEntry.message.role !== "assistant") {
		corrupt("tool_call_mismatch", `Tool start ${record.id} does not reference an assistant entry`);
	}
	const toolCalls = assistantEntry.message.content.filter((content) => content.type === "toolCall");
	const toolCall = toolCalls[record.toolIndex];
	if (!toolCall || toolCall.id !== record.toolCallId || toolCall.name !== record.toolName) {
		corrupt("tool_call_mismatch", `Tool start ${record.id} does not match its assistant tool-call ordinal`);
	}

	validateResultEntry(
		entriesById,
		record.resultEntryId,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === record.toolCallId &&
			entry.message.toolName === record.toolName,
		"tool result",
	);
}

function validateDeferredHandles(entries: Iterable<Entry>): void {
	for (const entry of entries) {
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason === "deferred" &&
			!entry.message.deferred
		) {
			corrupt("invalid_deferred_handle", `Deferred assistant entry ${entry.id} does not carry a handle`);
		}
	}
}

function validateOperationResult(entriesById: ReadonlyMap<string, Entry>, record: OperationStartedRecord): void {
	switch (record.intent.kind) {
		case "run":
			for (const target of record.intent.initialMessages) validateExactProvisionedEntry(entriesById, target);
			break;
		case "compaction":
			validateResultEntry(
				entriesById,
				record.intent.resultEntryId,
				(entry) => entry.type === "compaction",
				"manual compaction",
			);
			break;
		case "navigation":
			if (record.intent.summaryEntryId) {
				validateResultEntry(
					entriesById,
					record.intent.summaryEntryId,
					(entry) => entry.type === "branch_summary",
					"navigation summary",
				);
			}
			break;
	}
}

/** Validates a bounded lane recovery slice without reading or mutating session state. */
export function validateRecordLog(input: RecordLogSlice): void {
	if (input.openOperations.length > 1) {
		corrupt("multiple_open_operations", `Lane ${input.lane} has at least two open operations`);
	}

	const entriesById = new Map(input.entries.map((entry) => [entry.id, entry]));
	validateDeferredHandles(entriesById.values());
	const starts = new Map<string, OperationStartedRecord>();
	const finishedAt = new Map<string, number>();
	const abortedAt = new Map<string, number>();
	const queueEnqueues = new Map<string, Extract<LaneRecord, { type: "queue_enqueued" }>>();
	const latestAttempt = new Map<string, AttemptSeries>();
	const toolInvocations = new Set<string>();
	const records = [...input.records].sort((left, right) => left.seq - right.seq);

	for (const record of records) {
		if (record.type === "operation_started") {
			starts.set(record.id, record);
			validateOperationResult(entriesById, record);
			continue;
		}

		if (hasRunId(record)) {
			if (!starts.has(record.runId)) {
				corrupt("unknown_operation", `Record ${record.id} references unknown operation ${record.runId}`);
			}
			const finishSeq = finishedAt.get(record.runId);
			if (finishSeq !== undefined && record.seq > finishSeq) {
				corrupt("record_after_finish", `Record ${record.id} follows the finish of operation ${record.runId}`);
			}
		}

		switch (record.type) {
			case "operation_finished":
				finishedAt.set(record.runId, record.seq);
				break;
			case "abort_requested":
				abortedAt.set(record.runId, record.seq);
				break;
			case "step_attempt":
				validateAttemptReason(record);
				validateAttemptSequence(record, latestAttempt.get(record.runId), entriesById);
				validateAttemptResult(entriesById, record);
				latestAttempt.set(record.runId, { record });
				break;
			case "tool_started":
				validateToolStart(record, entriesById, toolInvocations);
				break;
			case "queue_enqueued":
				if (
					record.queue !== "nextRun" &&
					abortedAt.get(record.runId) !== undefined &&
					record.seq > abortedAt.get(record.runId)!
				) {
					corrupt("queue_after_abort", `${record.queue} item ${record.target.id} was enqueued after abort`);
				}
				queueEnqueues.set(record.target.id, record);
				validateExactProvisionedEntry(entriesById, record.target);
				break;
			case "queue_cancelled": {
				const enqueue = queueEnqueues.get(record.entryId);
				if (
					!enqueue ||
					enqueue.seq >= record.seq ||
					enqueue.runId !== record.runId ||
					entriesById.has(record.entryId)
				) {
					corrupt("invalid_queue_cancellation", `Queue cancellation ${record.id} has no pending matching enqueue`);
				}
				break;
			}
			case "write_deferred":
				validateExactProvisionedEntry(entriesById, record.target);
				break;
			case "usage":
				break;
		}
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function bySequence<T extends { seq: number }>(values: readonly T[]): T[] {
	return [...values].sort((left, right) => left.seq - right.seq);
}

function deriveEffectiveConfiguration(input: LaneReductionInput): EffectiveLaneConfiguration {
	let configuration = clone(input.defaults);
	const entriesById = new Map<string, Entry>();
	for (const entry of [...input.configurationEntries, ...input.ownEntries]) entriesById.set(entry.id, entry);

	for (const entry of bySequence([...entriesById.values()])) {
		switch (entry.type) {
			case "model_change":
				configuration = { ...configuration, model: { provider: entry.provider, modelId: entry.modelId } };
				break;
			case "thinking_level_change":
				configuration = { ...configuration, thinkingLevel: entry.thinkingLevel as ThinkingLevel };
				break;
			case "active_tools_change":
				configuration = { ...configuration, activeToolNames: [...entry.activeToolNames] };
				break;
			case "message":
				if (entry.message.role === "assistant") {
					configuration = {
						...configuration,
						model: { provider: entry.message.provider, modelId: entry.message.model },
					};
				}
				break;
		}
	}
	return configuration;
}

function deriveNewestOwn(
	entry: Entry | undefined,
): NonNullable<NonNullable<LaneState["operation"]>["newestOwn"]> | null {
	if (!entry) return null;
	if (entry.type !== "message") return { entryId: entry.id, type: entry.type };
	if (entry.message.role !== "assistant") {
		return { entryId: entry.id, type: entry.type, role: entry.message.role };
	}
	return {
		entryId: entry.id,
		type: entry.type,
		role: entry.message.role,
		stopReason: entry.message.stopReason,
	};
}

function deriveToolBatch(
	operationId: string,
	records: readonly LaneRecord[],
	ownEntries: readonly Entry[],
	entriesById: ReadonlyMap<string, Entry>,
	deferredWriteIds: ReadonlySet<string>,
): ToolBatchState | null {
	const assistantEntry = [...ownEntries]
		.reverse()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((content) => content.type === "toolCall"),
		);
	if (!assistantEntry || assistantEntry.type !== "message" || assistantEntry.message.role !== "assistant") return null;

	const toolCalls = assistantEntry.message.content.filter(
		(content): content is AgentToolCall => content.type === "toolCall",
	);
	const starts = new Map<number, ToolStartedRecord>();
	for (const record of records) {
		if (
			record.type === "tool_started" &&
			record.runId === operationId &&
			record.assistantEntryId === assistantEntry.id
		) {
			starts.set(record.toolIndex, record);
		}
	}

	const calls = toolCalls.map((toolCall, toolIndex) => {
		const started = starts.get(toolIndex);
		const startedResult = started ? entriesById.get(started.resultEntryId) : undefined;
		const blockedResult = ownEntries.find(
			(entry) =>
				entry.seq > assistantEntry.seq &&
				!deferredWriteIds.has(entry.id) &&
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCall.id,
		);
		const result = startedResult ?? blockedResult;
		return {
			toolIndex,
			toolCall: clone(toolCall),
			...(started ? { started: clone(started) } : {}),
			resultExists: result !== undefined,
			...(result?.type === "message" && result.terminate === true ? { terminate: true } : {}),
		};
	});

	return {
		assistantEntryId: assistantEntry.id,
		calls,
		truncated: assistantEntry.message.stopReason === "length",
		unresolved: calls.some((call) => !call.resultExists),
	};
}

/** Purely reconstructs one lane's orchestration state from its bounded recovery inputs. */
export function reduceLaneState(input: LaneReductionInput): LaneReductionResult {
	validateRecordLog(input);

	const records = bySequence(input.records);
	const ownEntries = bySequence(input.ownEntries);
	const entriesById = new Map<string, Entry>();
	for (const entry of [...input.entries, ...ownEntries]) entriesById.set(entry.id, entry);
	const cancelledQueueIds = new Set(
		records.filter((record) => record.type === "queue_cancelled").map((record) => record.entryId),
	);
	const pendingQueueRecords = records.filter(
		(record): record is QueueEnqueuedRecord =>
			record.type === "queue_enqueued" &&
			!entriesById.has(record.target.id) &&
			!cancelledQueueIds.has(record.target.id),
	);
	const started = input.openOperations[0];
	const capturedInitialMessageIds = new Set(
		started?.intent.kind === "run" ? started.intent.initialMessages.map((target) => target.id) : [],
	);
	const pendingNextRun = pendingQueueRecords
		.filter((record) => record.queue === "nextRun" && !capturedInitialMessageIds.has(record.target.id))
		.map((record) => clone(record.target));
	const effectiveConfiguration = deriveEffectiveConfiguration(input);

	if (!started) {
		return {
			laneState: { lane: input.lane, leafId: input.leafId, operation: null, pendingNextRun },
			effectiveConfiguration,
			terminalFailure: null,
		};
	}

	const operationRecords = records.filter((record) =>
		record.type === "operation_started" ? record.id === started.id : "runId" in record && record.runId === started.id,
	);
	const aborting = operationRecords.some((record) => record.type === "abort_requested");
	const pendingSteer = aborting
		? []
		: pendingQueueRecords
				.filter((record) => record.queue === "steer" && record.runId === started.id)
				.map((record) => clone(record.target));
	const pendingFollowUp = aborting
		? []
		: pendingQueueRecords
				.filter((record) => record.queue === "followUp" && record.runId === started.id)
				.map((record) => clone(record.target));
	const pendingWrites = operationRecords
		.filter(
			(record): record is WriteDeferredRecord =>
				record.type === "write_deferred" && !entriesById.has(record.target.id),
		)
		.map((record) => clone(record.target));
	const missingInitialMessages =
		started.intent.kind === "run"
			? started.intent.initialMessages.filter((target) => !entriesById.has(target.id)).map(clone)
			: [];

	const newestAttempt = operationRecords.filter((record) => record.type === "step_attempt").at(-1);
	const step =
		newestAttempt && !entriesById.has(newestAttempt.resultEntryId)
			? {
					kind: newestAttempt.step,
					attempts: newestAttempt.attempt,
					resultEntryId: newestAttempt.resultEntryId,
					...(newestAttempt.step === "compaction" ? { compactionReason: newestAttempt.compactionReason } : {}),
				}
			: null;

	const consumedInputIds = new Set<string>();
	if (started.intent.kind === "run") {
		for (const target of started.intent.initialMessages) consumedInputIds.add(target.id);
	}
	for (const record of operationRecords) {
		if (record.type === "queue_enqueued" && record.queue !== "nextRun") consumedInputIds.add(record.target.id);
	}
	let newestConsumedInputSequence = Number.NEGATIVE_INFINITY;
	for (const id of consumedInputIds) {
		const entry = entriesById.get(id);
		if (entry?.type === "message") newestConsumedInputSequence = Math.max(newestConsumedInputSequence, entry.seq);
	}
	const overflowRecoveryUsed = operationRecords.some(
		(record) =>
			record.type === "step_attempt" &&
			record.step === "compaction" &&
			record.compactionReason === "overflow" &&
			record.seq > newestConsumedInputSequence,
	);

	const newestOwnEntry = ownEntries.at(-1);
	const newestOwn = deriveNewestOwn(newestOwnEntry);
	const deferred =
		newestOwnEntry?.type === "message" &&
		newestOwnEntry.message.role === "assistant" &&
		newestOwnEntry.message.stopReason === "deferred" &&
		newestOwnEntry.message.deferred
			? clone(newestOwnEntry.message.deferred)
			: null;
	const targets: { result?: boolean; summary?: boolean } = {};
	if (started.intent.kind === "compaction") {
		targets.result = entriesById.has(started.intent.resultEntryId);
	} else if (started.intent.kind === "navigation" && started.intent.summaryEntryId) {
		targets.summary = entriesById.has(started.intent.summaryEntryId);
	}

	const deferredWriteIds = new Set(
		operationRecords.filter((record) => record.type === "write_deferred").map((record) => record.target.id),
	);
	let terminalFailure: TerminalFailureState | null = null;
	if (
		newestOwnEntry?.type === "message" &&
		newestOwnEntry.message.role === "assistant" &&
		newestOwnEntry.message.stopReason === "error" &&
		!deferredWriteIds.has(newestOwnEntry.id)
	) {
		const producedByStep = operationRecords.some(
			(record) => record.type === "step_attempt" && record.resultEntryId === newestOwnEntry.id,
		);
		const previousOwnEntry = ownEntries.at(-2);
		const producedByDeferredFetch =
			operationRecords.some(
				(record) =>
					record.type === "usage" && record.cause === "deferred_fetch" && record.entryId === newestOwnEntry.id,
			) ||
			(previousOwnEntry?.type === "message" &&
				previousOwnEntry.message.role === "assistant" &&
				previousOwnEntry.message.stopReason === "deferred");
		if (producedByStep || producedByDeferredFetch) {
			terminalFailure = {
				entryId: newestOwnEntry.id,
				source: producedByStep ? "step" : "deferred_fetch",
				message: clone(newestOwnEntry.message),
			};
		}
	}

	return {
		laneState: {
			lane: input.lane,
			leafId: input.leafId,
			operation: {
				id: started.id,
				kind: started.intent.kind,
				intent: clone(started.intent),
				aborting,
				step,
				toolBatch: deriveToolBatch(started.id, operationRecords, ownEntries, entriesById, deferredWriteIds),
				missingInitialMessages,
				pendingSteer,
				pendingFollowUp,
				pendingWrites,
				deferred,
				overflowRecoveryUsed,
				newestOwn,
				targets,
			},
			pendingNextRun,
		},
		effectiveConfiguration,
		terminalFailure,
	};
}
