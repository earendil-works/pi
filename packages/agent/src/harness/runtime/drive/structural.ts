import {
	type Api,
	type AssistantMessage,
	isRetryableAssistantError,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { HarnessEvent } from "../../agent-harness.ts";
import type { BranchPreparation, BranchSummaryResult } from "../../compaction/branch-summarization.ts";
import { generateBranchSummaryWithRequest } from "../../compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactResult, SummaryRequest } from "../../compaction/compaction.ts";
import { compactWithRequest, prepareCompaction, shouldCompact } from "../../compaction/compaction.ts";
import { type Context, getTelemetryContext, withAbortSignal } from "../../context.ts";
import { AbortRequested } from "../../execution/effect-gate.ts";
import { applyStreamOptionsPatch } from "../../hooks.ts";
import { insertEntry, insertUsage } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type AssistantEffectPendingOperation,
	type AssistantReadyOperation,
	type BranchSummaryEntry,
	type CheckpointOperation,
	type CommitResult,
	type CompactionEntry,
	type DurableFileOperations,
	type DurableStructuralPreparation,
	type JsonValue,
	type LaneConfiguration,
	type NavigationReadyToCommitOperation,
	type NewEntry,
	type OperationError,
	operationScopeOf,
	type ResultBoundary,
	type SummaryContext,
	type SummaryDecidingOperation,
	type SummaryEffectPendingOperation,
	type SummaryReadyOperation,
	type SummaryRetryWaitOperation,
	type SummaryTask,
	type UsageRow,
	type Write,
} from "../../session/types.ts";
import { branchTip, entryLabel, operationPreparation, setValue } from "../../session/values.ts";
import type { AgentHarnessStreamOptions } from "../../types.ts";
import type { Lane } from "../lane.ts";
import { committedEntryEvents, readBoundedEntries } from "../transcript.ts";
import type { ContinueOperationResult, Drive, ProcedureResult } from "../types.ts";
import {
	assistantReadyAtBoundary,
	type BoundaryFinishPending,
	boundaryPlacementEvents,
	finishRunBoundary,
	normalizedRetryPolicy,
	planBoundaryInbox,
} from "./boundary.ts";
import { retryDelay, retryNotBefore, waitUntil } from "./retry.ts";
import { operationCleanupWrites, operationResultRecord } from "./terminal.ts";

class StructuralCancelled extends Error {
	constructor() {
		super("Structural generation was cancelled");
		this.name = "StructuralCancelled";
	}
}

function durableFileOperations(fileOps: CompactionPreparation["fileOps"]): DurableFileOperations {
	return {
		read: [...fileOps.read],
		written: [...fileOps.written],
		edited: [...fileOps.edited],
	};
}

export function durableCompactionPreparation(
	preparation: CompactionPreparation,
): Extract<DurableStructuralPreparation, { kind: "compaction" }> {
	return {
		kind: "compaction",
		messagesToSummarize: preparation.messagesToSummarize,
		turnPrefixMessages: preparation.turnPrefixMessages,
		retainedTail: preparation.retainedTail,
		isSplitTurn: preparation.isSplitTurn,
		tokensBefore: preparation.tokensBefore,
		...(preparation.previousSummary === undefined ? {} : { previousSummary: preparation.previousSummary }),
		fileOps: durableFileOperations(preparation.fileOps),
		settings: preparation.settings,
	};
}

export function durableBranchPreparation(
	preparation: BranchPreparation,
): Extract<DurableStructuralPreparation, { kind: "branch_summary" }> {
	return {
		kind: "branch_summary",
		messages: preparation.messages,
		fileOps: durableFileOperations(preparation.fileOps),
		totalTokens: preparation.totalTokens,
	};
}

function fileOperations(fileOps: DurableFileOperations): CompactionPreparation["fileOps"] {
	return {
		read: new Set(fileOps.read),
		written: new Set(fileOps.written),
		edited: new Set(fileOps.edited),
	};
}

function compactionPreparation(
	preparation: Extract<DurableStructuralPreparation, { kind: "compaction" }>,
): CompactionPreparation {
	return {
		messagesToSummarize: preparation.messagesToSummarize,
		turnPrefixMessages: preparation.turnPrefixMessages,
		retainedTail: preparation.retainedTail,
		isSplitTurn: preparation.isSplitTurn,
		tokensBefore: preparation.tokensBefore,
		...(preparation.previousSummary === undefined ? {} : { previousSummary: preparation.previousSummary }),
		fileOps: fileOperations(preparation.fileOps),
		settings: preparation.settings,
	};
}

function branchPreparation(
	preparation: Extract<DurableStructuralPreparation, { kind: "branch_summary" }>,
): BranchPreparation {
	return {
		messages: preparation.messages,
		fileOps: fileOperations(preparation.fileOps),
		totalTokens: preparation.totalTokens,
	};
}

function summaryKind(task: SummaryTask): DurableStructuralPreparation["kind"] {
	return task.boundary.kind === "commit_navigation" ? "branch_summary" : "compaction";
}

function compactionReason(task: SummaryTask): "manual" | "threshold" | "overflow" {
	if (task.reason !== undefined) return task.reason;
	if (task.boundary.kind === "finish") return "manual";
	throw new SessionInvariantError(`In-run compaction task ${task.taskId} is missing its reason`);
}

function navigationBoundary(task: SummaryTask): Extract<ResultBoundary, { kind: "commit_navigation" }> {
	if (task.boundary.kind !== "commit_navigation") {
		throw new SessionInvariantError(`Summary task ${task.taskId} is not a navigation`);
	}
	return task.boundary;
}

async function readStructuralPreparation<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deciding: SummaryDecidingOperation,
): Promise<ContinueOperationResult<CompactionPreparation | BranchPreparation>> {
	return lane.continueOperation(
		deciding,
		async (_state, current, _meta, reader) => {
			const expected = summaryKind(current.task);
			const stored = await reader.getValue(
				operationPreparation(drive.operationId, current.task.taskId),
				drive.context,
			);
			if (stored?.value.kind !== expected) {
				throw new SessionInvariantError(
					`Structural task ${current.task.taskId} is missing its ${expected} preparation`,
				);
			}
			if (current.task.boundary.kind === "commit_navigation") {
				const targetId = current.task.boundary.targetId;
				if (!(await reader.getEntries([targetId], drive.context)).has(targetId)) {
					throw new SessionInvariantError(`Navigation target ${targetId} is missing`);
				}
			}
			return {
				kind: "return",
				result:
					stored.value.kind === "compaction"
						? compactionPreparation(stored.value)
						: branchPreparation(stored.value),
			};
		},
		drive.context,
	);
}

function summaryContext<TContext extends object | undefined>(
	lane: Lane<TContext>,
	resultEntryId: string,
	configuration: LaneConfiguration,
): SummaryContext {
	return {
		resultEntryId,
		configuration,
		streamOptions: { ...lane.readConfig().streamOptions, deferred: false },
		retryPolicy: normalizedRetryPolicy(lane),
	};
}

function usageEvent(row: Omit<UsageRow, "seq">, writeIndex: number, commit: CommitResult, lane: string): HarnessEvent {
	return {
		type: "usage",
		lane,
		row: { ...row, seq: commit.seqs[writeIndex]! },
		totals: commit.stats.usage,
	};
}

function operationError(code: string, message: string, details?: JsonValue): OperationError {
	return { code, message, ...(details === undefined ? {} : { details }) };
}

type StructuralOutcome =
	| { kind: "compaction"; resultEntryId: string; result: CompactResult; fromHook: boolean }
	| { kind: "branch_summary"; resultEntryId: string; result: BranchSummaryResult; fromHook: boolean }
	| { kind: "declined" }
	| { kind: "failed"; error: OperationError };

type StructuralPublication = ProcedureResult | BoundaryFinishPending;

async function publishStructuralOutcome<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: SummaryDecidingOperation | SummaryReadyOperation | SummaryEffectPendingOperation,
	outcome: StructuralOutcome,
): Promise<ProcedureResult> {
	const hookUsageId =
		(outcome.kind === "compaction" || outcome.kind === "branch_summary") &&
		outcome.fromHook &&
		outcome.result.usage !== undefined
			? lane.session.idGenerator.next()
			: undefined;
	const published = await lane.continueOperation<
		SummaryDecidingOperation | SummaryReadyOperation | SummaryEffectPendingOperation,
		StructuralPublication
	>(
		capability,
		async (state, current, meta, reader) => {
			const expected = summaryKind(current.task);
			let terminalCompactionEndedAt: number | undefined;
			if ((outcome.kind === "compaction" || outcome.kind === "branch_summary") && outcome.kind !== expected) {
				throw new SessionInvariantError(
					`Structural ${outcome.kind} result does not match ${expected} task ${current.task.taskId}`,
				);
			}

			const writes: Write[] = [];
			const baseEvents: ((commit: CommitResult) => HarnessEvent[])[] = [];
			let terminalTipId = state.tipId;
			if (hookUsageId !== undefined && (outcome.kind === "compaction" || outcome.kind === "branch_summary")) {
				const usage = outcome.result.usage;
				if (usage === undefined) throw new SessionInvariantError("Hook usage id exists without structural usage");
				const row: Omit<UsageRow, "seq"> = { id: hookUsageId, usage, adjustment: false };
				const writeIndex = writes.length;
				writes.push(insertUsage(row));
				baseEvents.push((commit) => [usageEvent(row, writeIndex, commit, lane.name)]);
			}

			if (outcome.kind === "compaction") {
				const entry: NewEntry<CompactionEntry> = {
					id: outcome.resultEntryId,
					parentId: state.tipId,
					type: "compaction",
					summary: outcome.result.summary,
					retainedTail: outcome.result.retainedTail,
					tokensBefore: outcome.result.tokensBefore,
					...(outcome.result.details === undefined ? {} : { details: outcome.result.details }),
					...(outcome.result.usage === undefined ? {} : { usage: outcome.result.usage }),
					fromHook: outcome.fromHook,
				};
				const entryWriteIndex = writes.length;
				writes.push(insertEntry(entry), setValue(branchTip(lane.name), outcome.resultEntryId));
				terminalTipId = outcome.resultEntryId;
				baseEvents.push((commit) =>
					committedEntryEvents([entry], commit, lane.name, drive.operationId, entryWriteIndex),
				);
			} else if (outcome.kind === "branch_summary") {
				const boundary = navigationBoundary(current.task);
				const entry: NewEntry<BranchSummaryEntry> = {
					id: outcome.resultEntryId,
					parentId: boundary.targetId,
					type: "branch_summary",
					fromId: meta.sourceTipId,
					summary: outcome.result.summary,
					details: { readFiles: outcome.result.readFiles, modifiedFiles: outcome.result.modifiedFiles },
					...(outcome.result.usage === undefined ? {} : { usage: outcome.result.usage }),
					fromHook: outcome.fromHook,
				};
				writes.push(setValue(branchTip(lane.name), boundary.targetId));
				const entryWriteIndex = writes.length;
				writes.push(insertEntry(entry), setValue(branchTip(lane.name), outcome.resultEntryId));
				if (boundary.label !== undefined) writes.push(setValue(entryLabel(boundary.targetId), boundary.label));
				terminalTipId = outcome.resultEntryId;
				baseEvents.push((commit) =>
					committedEntryEvents([entry], commit, lane.name, drive.operationId, entryWriteIndex),
				);
			}

			const attempt =
				current.at === "summary.ready"
					? current.nextAttempt
					: current.at === "summary.effect_pending"
						? current.attempt
						: undefined;
			if (attempt !== undefined && attempt > 1) {
				baseEvents.push(() => [
					{
						type: "retry_end",
						lane: lane.name,
						runId: drive.operationId,
						step: current.task.taskId,
						attempt,
						success: outcome.kind === "compaction" || outcome.kind === "branch_summary",
						...(outcome.kind === "failed" ? { finalError: outcome.error.message } : {}),
					},
				]);
			}
			if (outcome.kind === "compaction") {
				baseEvents.push((commit) => [
					{
						type: "compaction_end",
						lane: lane.name,
						runId: drive.operationId,
						reason: compactionReason(current.task),
						status: "completed",
						entryId: outcome.resultEntryId,
						endedAt: terminalCompactionEndedAt ?? commit.timestamp,
					},
				]);
			}
			const events = (commit: CommitResult): HarnessEvent[] =>
				baseEvents.flatMap((materialize) => materialize(commit));
			switch (current.task.boundary.kind) {
				case "resume_checkpoint": {
					if (outcome.kind === "branch_summary") {
						throw new SessionInvariantError("Run compaction boundary received a branch summary");
					}
					if (
						outcome.kind === "compaction" ||
						(outcome.kind === "declined" && current.task.reason === "threshold")
					) {
						if (terminalTipId === null) throw new SessionInvariantError("Run compaction has no Branch tip");
						const continuation = current.task.boundary.resumeAfter.continuation;
						const placement = await planBoundaryInbox(
							lane,
							drive,
							state,
							current,
							reader,
							terminalTipId,
							outcome.kind === "declined" && continuation.kind === "may_finish",
						);
						if (
							outcome.kind === "declined" &&
							placement.triggerEntryId === undefined &&
							continuation.kind === "may_finish"
						) {
							return {
								kind: "return",
								result: {
									kind: "finish_pending",
									entryIds: placement.entries.map((entry) => entry.id),
								} as const,
							};
						}
						const placementWriteIndex = writes.length;
						writes.push(...placement.writes);
						let operationState: AssistantReadyOperation | CheckpointOperation;
						if (placement.triggerEntryId !== undefined || continuation.kind === "need_assistant") {
							const overflowRecoveryUsed =
								placement.triggerEntryId === undefined && continuation.kind === "need_assistant"
									? continuation.overflowRecoveryUsed
									: false;
							operationState = assistantReadyAtBoundary(
								lane,
								state,
								current,
								placement.triggerEntryId ?? current.task.boundary.resumeAfter.triggerEntryId,
								overflowRecoveryUsed,
							);
						} else {
							operationState = {
								...operationScopeOf(current),
								at: "checkpoint",
								...current.task.boundary.resumeAfter,
							};
						}
						return {
							kind: "commit",
							writes,
							operationState,
							lane: { tipId: placement.tipId, inbox: placement.inbox },
							materialize: () => ({ kind: "continue" }) as const,
							events: (commit) => [
								...(outcome.kind === "compaction"
									? events(commit)
									: [
											{
												type: "compaction_end" as const,
												lane: lane.name,
												runId: drive.operationId,
												reason: "threshold" as const,
												status: "declined" as const,
												endedAt: commit.timestamp,
											},
										]),
								...boundaryPlacementEvents(
									placement,
									commit,
									placementWriteIndex,
									lane.name,
									drive.operationId,
								),
							],
						};
					}
					if (state.tipId === null) throw new SessionInvariantError("Failed run has no Branch tip");
					const error =
						outcome.kind === "declined"
							? operationError("compaction_declined", "Overflow compaction was declined")
							: outcome.error;
					const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
					const record = operationResultRecord(meta, "failed", state.tipId, error);
					const compactionEnd: HarnessEvent =
						outcome.kind === "declined"
							? {
									type: "compaction_end",
									lane: lane.name,
									runId: drive.operationId,
									reason: compactionReason(current.task),
									status: "declined",
									endedAt: record.endedAt,
								}
							: {
									type: "compaction_end",
									lane: lane.name,
									runId: drive.operationId,
									reason: compactionReason(current.task),
									status: "failed",
									error: outcome.error,
									endedAt: record.endedAt,
								};
					return {
						kind: "finish",
						writes: [...writes, ...cleanup],
						record,
						materialize: () => ({ kind: "settled", outcome: record }) as const,
						events: (commit) => [
							...events(commit),
							compactionEnd,
							{
								type: "run_end",
								lane: lane.name,
								runId: drive.operationId,
								status: "failed",
								error,
								fromTipId: meta.sourceTipId,
								tipId: state.tipId,
								endedAt: record.endedAt,
							},
						],
					};
				}
				case "finish": {
					if (outcome.kind === "branch_summary") {
						throw new SessionInvariantError("Compaction finish boundary received a branch summary");
					}
					if (outcome.kind !== "compaction" && state.tipId === null) {
						throw new SessionInvariantError("Standalone compaction has no Branch tip");
					}
					const error = outcome.kind === "failed" ? outcome.error : undefined;
					const status =
						outcome.kind === "declined" ? "declined" : outcome.kind === "failed" ? "failed" : "completed";
					const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
					const record = operationResultRecord(meta, status, terminalTipId, error);
					terminalCompactionEndedAt = record.endedAt;
					const compactionEnd: HarnessEvent | undefined =
						outcome.kind === "compaction"
							? undefined
							: outcome.kind === "declined"
								? {
										type: "compaction_end",
										lane: lane.name,
										runId: drive.operationId,
										reason: "manual",
										status: "declined",
										endedAt: record.endedAt,
									}
								: {
										type: "compaction_end",
										lane: lane.name,
										runId: drive.operationId,
										reason: "manual",
										status: "failed",
										error: outcome.error,
										endedAt: record.endedAt,
									};
					return {
						kind: "finish",
						writes: [...writes, ...cleanup],
						record,
						...(outcome.kind === "compaction" ? { lane: { tipId: terminalTipId } } : {}),
						materialize: () => ({ kind: "settled", outcome: record }) as const,
						events: (commit) => [...events(commit), ...(compactionEnd === undefined ? [] : [compactionEnd])],
					};
				}
				case "commit_navigation": {
					if (outcome.kind === "compaction") {
						throw new SessionInvariantError("Navigation boundary received a compaction result");
					}
					const error = outcome.kind === "failed" ? outcome.error : undefined;
					const status =
						outcome.kind === "declined" ? "declined" : outcome.kind === "failed" ? "failed" : "completed";
					const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
					const record = operationResultRecord(meta, status, terminalTipId, error);
					const navigationEnd: HarnessEvent =
						outcome.kind === "branch_summary"
							? {
									type: "navigation_end",
									lane: lane.name,
									runId: drive.operationId,
									status: "completed",
									fromTipId: meta.sourceTipId,
									tipId: terminalTipId,
									endedAt: record.endedAt,
								}
							: outcome.kind === "declined"
								? {
										type: "navigation_end",
										lane: lane.name,
										runId: drive.operationId,
										status: "declined",
										fromTipId: meta.sourceTipId,
										tipId: terminalTipId,
										endedAt: record.endedAt,
									}
								: {
										type: "navigation_end",
										lane: lane.name,
										runId: drive.operationId,
										status: "failed",
										error: outcome.error,
										fromTipId: meta.sourceTipId,
										tipId: terminalTipId,
										endedAt: record.endedAt,
									};
					return {
						kind: "finish",
						writes: [...writes, ...cleanup],
						record,
						...(outcome.kind === "branch_summary" ? { lane: { tipId: terminalTipId } } : {}),
						materialize: () => ({ kind: "settled", outcome: record }) as const,
						events: (commit) => [...events(commit), navigationEnd],
					};
				}
			}
		},
		drive.context,
	);
	if (published.kind === "cancel_requested") return { kind: "continue" };
	if (published.value.kind !== "finish_pending") return published.value;
	const boundary = capability.task.boundary;
	if (boundary.kind !== "resume_checkpoint" || boundary.resumeAfter.continuation.kind !== "may_finish") {
		throw new SessionInvariantError("Structural finish mediation requires a resumable finish boundary");
	}
	return finishRunBoundary(lane, drive, capability, boundary.resumeAfter.continuation, published.value.entryIds, [
		{
			type: "compaction_end",
			lane: lane.name,
			runId: drive.operationId,
			reason: "threshold",
			status: "declined",
			endedAt: Date.now(),
		},
	]);
}

async function publishStructuralReady<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deciding: SummaryDecidingOperation,
): Promise<ProcedureResult> {
	const resultEntryId = lane.session.idGenerator.next();
	const published = await lane.continueOperation(
		deciding,
		(state, current) => {
			const operationState: SummaryReadyOperation = {
				...operationScopeOf(current),
				at: "summary.ready",
				task: current.task,
				summaryContext: summaryContext(lane, resultEntryId, state.configuration),
				nextAttempt: 1,
			};
			return {
				kind: "commit",
				writes: [],
				operationState,
				materialize: () => ({ kind: "continue" }) as const,
			};
		},
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

/** Consume one durable structural preparation and decision hook. */
export async function runStructuralDecision<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deciding: SummaryDecidingOperation,
): Promise<ProcedureResult> {
	const preparation = await readStructuralPreparation(lane, drive, deciding);
	if (preparation.kind === "cancel_requested") return { kind: "continue" };
	if (deciding.task.boundary.kind === "commit_navigation") {
		if (!("messages" in preparation.value)) {
			throw new SessionInvariantError("Navigation task has invalid durable preparation");
		}
		const hook = await lane.hooks.runWithGate(
			"before_navigation",
			{
				lane: lane.name,
				runId: drive.operationId,
				targetId: deciding.task.boundary.targetId,
				preparation: preparation.value,
				...(deciding.task.customInstructions === undefined
					? {}
					: { customInstructions: deciding.task.customInstructions }),
			},
			drive.gate,
			drive.context,
		);
		if (hook?.decline === true) return publishStructuralOutcome(lane, drive, deciding, { kind: "declined" });
		if (hook?.summary !== undefined) {
			return publishStructuralOutcome(lane, drive, deciding, {
				kind: "branch_summary",
				resultEntryId: lane.session.idGenerator.next(),
				result: hook.summary,
				fromHook: true,
			});
		}
		return publishStructuralReady(lane, drive, deciding);
	}

	if (!("messagesToSummarize" in preparation.value)) {
		throw new SessionInvariantError("Compaction task has invalid durable preparation");
	}
	const hook = await lane.hooks.runWithGate(
		"before_compaction",
		{
			lane: lane.name,
			runId: drive.operationId,
			reason: compactionReason(deciding.task),
			preparation: preparation.value,
			...(deciding.task.customInstructions === undefined
				? {}
				: { customInstructions: deciding.task.customInstructions }),
		},
		drive.gate,
		drive.context,
	);
	if (hook?.decline === true) return publishStructuralOutcome(lane, drive, deciding, { kind: "declined" });
	if (hook?.compaction !== undefined) {
		return publishStructuralOutcome(lane, drive, deciding, {
			kind: "compaction",
			resultEntryId: lane.session.idGenerator.next(),
			result: hook.compaction,
			fromHook: true,
		});
	}
	return publishStructuralReady(lane, drive, deciding);
}

function effectPendingFromReady(ready: SummaryReadyOperation): SummaryEffectPendingOperation {
	return {
		...operationScopeOf(ready),
		at: "summary.effect_pending",
		task: ready.task,
		summaryContext: ready.summaryContext,
		attempt: ready.nextAttempt,
		usageIds: [],
	};
}

function retryWaitFromEffect(effect: SummaryEffectPendingOperation, errorMessage: string): SummaryRetryWaitOperation {
	return {
		...operationScopeOf(effect),
		at: "summary.retry_wait",
		task: effect.task,
		summaryContext: effect.summaryContext,
		nextAttempt: effect.attempt + 1,
		notBefore: retryNotBefore(effect.summaryContext.retryPolicy.baseDelayMs, effect.attempt),
		errorMessage,
	};
}

function readyFromRetryWait(retry: SummaryRetryWaitOperation): SummaryReadyOperation {
	return {
		...operationScopeOf(retry),
		at: "summary.ready",
		task: retry.task,
		summaryContext: retry.summaryContext,
		nextAttempt: retry.nextAttempt,
	};
}

async function publishAttemptIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	ready: SummaryReadyOperation,
): Promise<ContinueOperationResult<SummaryEffectPendingOperation>> {
	return lane.continueOperation(
		ready,
		(_state, current) => {
			const effectPending = effectPendingFromReady(current);
			return {
				kind: "commit",
				writes: [],
				operationState: effectPending,
				materialize: () => effectPending,
			};
		},
		drive.context,
	);
}

async function publishNestedRequestIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: SummaryEffectPendingOperation,
	index: number,
	usageId: string,
): Promise<ContinueOperationResult<SummaryEffectPendingOperation>> {
	return lane.continueOperation(
		effect,
		(_state, current) => {
			const next = { ...current, request: { index, usageId } };
			return {
				kind: "commit",
				writes: [],
				operationState: next,
				materialize: () => next,
			};
		},
		drive.context,
	);
}

async function publishNestedRequestOutcome<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: SummaryEffectPendingOperation,
	usageId: string,
	response: AssistantMessage,
): Promise<void> {
	await lane.settleOperation(
		effect,
		(_state, current) => {
			const next = { ...current, usageIds: [...current.usageIds, usageId] };
			delete next.request;
			const row: Omit<UsageRow, "seq"> = { id: usageId, usage: response.usage, adjustment: false };
			return {
				kind: "commit",
				writes: [insertUsage(row)],
				operationState: next,
				materialize: () => undefined,
				events: (commit) => [usageEvent(row, 0, commit, lane.name)],
			};
		},
		drive.context,
	);
}

function requestStreamOptions(
	options: SimpleStreamOptions,
	streamOptions: AgentHarnessStreamOptions,
	context: Context,
	onPayload: NonNullable<SimpleStreamOptions["onPayload"]>,
): SimpleStreamOptions {
	return {
		...options,
		transport: streamOptions.transport,
		timeoutMs: streamOptions.timeoutMs,
		maxRetries: streamOptions.maxRetries,
		maxRetryDelayMs: streamOptions.maxRetryDelayMs,
		headers: streamOptions.headers,
		metadata: streamOptions.metadata,
		cacheRetention: "none",
		deferred: false,
		signal: context.abortSignal,
		telemetryContext: getTelemetryContext(context),
		onPayload,
	};
}

async function performStructuralAttempt<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: SummaryEffectPendingOperation,
	model: Model<Api>,
	preparation: CompactionPreparation | BranchPreparation,
): Promise<
	| { kind: "compaction"; result: CompactResult; retryable: boolean }
	| { kind: "branch_summary"; result: BranchSummaryResult; retryable: boolean }
	| { kind: "error"; error: OperationError; retryable: boolean }
	| { kind: "cancel_requested" }
> {
	let requestIndex = 0;
	let lastResponse: AssistantMessage | undefined;
	const request: SummaryRequest = async (aiContext, options, requestContext) => {
		const baseOptions: AgentHarnessStreamOptions = { ...effect.summaryContext.streamOptions, deferred: false };
		const beforeRequest = await lane.hooks
			.runWithGate(
				"before_request",
				{
					lane: lane.name,
					runId: drive.operationId,
					model,
					step: summaryKind(effect.task),
					attempt: effect.attempt,
					streamOptions: baseOptions,
				},
				drive.gate,
				requestContext,
			)
			.catch(async (error: unknown) => {
				if (!(error instanceof AbortRequested)) throw error;
				await error.cancellation;
				throw new StructuralCancelled();
			});
		const streamOptions = {
			...(beforeRequest?.streamOptions === undefined
				? baseOptions
				: applyStreamOptionsPatch(baseOptions, beforeRequest.streamOptions)),
			deferred: false as const,
		};
		const usageId = lane.session.idGenerator.next();
		const intent = await publishNestedRequestIntent(lane, drive, effect, requestIndex, usageId);
		requestIndex += 1;
		if (intent.kind === "cancel_requested") throw new StructuralCancelled();
		const admittedContext = withAbortSignal(drive.gate.signal, requestContext);
		let response: AssistantMessage;
		try {
			response = await drive.gate.admit(() =>
				lane.models.completeSimple(
					model,
					aiContext,
					requestStreamOptions(options, streamOptions, admittedContext, async (payload, requestModel) => {
						const hook = await lane.hooks.runWithGate(
							"before_payload",
							{ lane: lane.name, runId: drive.operationId, model: requestModel, payload },
							drive.gate,
							admittedContext,
						);
						return hook?.payload;
					}),
				),
			);
		} catch (error) {
			if (!(error instanceof AbortRequested)) throw error;
			await error.cancellation;
			throw new StructuralCancelled();
		}
		lastResponse = response;
		await publishNestedRequestOutcome(lane, drive, intent.value, usageId, response);
		return response;
	};

	try {
		if (summaryKind(effect.task) === "compaction") {
			if (!("messagesToSummarize" in preparation)) {
				throw new SessionInvariantError("Compaction summary has invalid durable preparation");
			}
			const result = await compactWithRequest(
				preparation,
				{
					model,
					customInstructions: effect.task.customInstructions,
					thinkingLevel: effect.summaryContext.configuration.thinkingLevel,
				},
				request,
				drive.context,
			);
			if (!result.ok) {
				return {
					kind: "error",
					error: operationError(result.error.code, result.error.message),
					retryable: lastResponse !== undefined && isRetryableAssistantError(lastResponse),
				};
			}
			return {
				kind: "compaction",
				result: result.value,
				retryable: lastResponse !== undefined && isRetryableAssistantError(lastResponse),
			};
		}

		if (!("messages" in preparation)) {
			throw new SessionInvariantError("Branch summary has invalid durable preparation");
		}
		const result = await generateBranchSummaryWithRequest(
			preparation,
			{ customInstructions: effect.task.customInstructions },
			request,
			drive.context,
		);
		if (!result.ok) {
			return {
				kind: "error",
				error: operationError(result.error.code, result.error.message),
				retryable: lastResponse !== undefined && isRetryableAssistantError(lastResponse),
			};
		}
		return {
			kind: "branch_summary",
			result: result.value,
			retryable: lastResponse !== undefined && isRetryableAssistantError(lastResponse),
		};
	} catch (error) {
		if (error instanceof StructuralCancelled) return { kind: "cancel_requested" };
		throw error;
	}
}

async function readAttemptPreparation<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	ready: SummaryReadyOperation,
): Promise<ContinueOperationResult<CompactionPreparation | BranchPreparation>> {
	return lane.continueOperation(
		ready,
		async (_state, current, _meta, reader) => {
			const expected = summaryKind(current.task);
			const stored = await reader.getValue(
				operationPreparation(drive.operationId, current.task.taskId),
				drive.context,
			);
			if (stored === undefined || stored.value.kind !== expected) {
				throw new SessionInvariantError(`Structural task ${current.task.taskId} has invalid durable preparation`);
			}
			return {
				kind: "return",
				result:
					stored.value.kind === "compaction"
						? compactionPreparation(stored.value)
						: branchPreparation(stored.value),
			};
		},
		drive.context,
	);
}

async function publishAttemptResult<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: SummaryEffectPendingOperation,
	result: Awaited<ReturnType<typeof performStructuralAttempt<TContext>>>,
): Promise<ProcedureResult> {
	if (result.kind === "cancel_requested") return { kind: "continue" };
	if (result.kind === "compaction") {
		return publishStructuralOutcome(lane, drive, effect, {
			kind: "compaction",
			resultEntryId: effect.summaryContext.resultEntryId,
			result: result.result,
			fromHook: false,
		});
	}
	if (result.kind === "branch_summary") {
		return publishStructuralOutcome(lane, drive, effect, {
			kind: "branch_summary",
			resultEntryId: effect.summaryContext.resultEntryId,
			result: result.result,
			fromHook: false,
		});
	}
	if (result.error.code === "aborted" && lane.state.operation!.state.control.status === "running") {
		throw new SessionInvariantError("Structural provider response is aborted while durable control is running");
	}
	if (result.retryable && effect.attempt < effect.summaryContext.retryPolicy.maxAttempts) {
		const retryWait = retryWaitFromEffect(effect, result.error.message);
		const published = await lane.continueOperation(
			effect,
			() => ({
				kind: "commit",
				writes: [],
				operationState: retryWait,
				materialize: () => ({ kind: "continue" }) as const,
				events: () => [
					{
						type: "retry_scheduled",
						lane: lane.name,
						runId: drive.operationId,
						step: effect.task.taskId,
						attempt: retryWait.nextAttempt,
						maxAttempts: effect.summaryContext.retryPolicy.maxAttempts,
						delayMs: retryDelay(effect.summaryContext.retryPolicy.baseDelayMs, effect.attempt),
						notBefore: retryWait.notBefore,
						errorMessage: result.error.message,
					},
				],
			}),
			drive.context,
		);
		return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
	}
	return publishStructuralOutcome(lane, drive, effect, { kind: "failed", error: result.error });
}

/** Execute one ready structural generation attempt. */
export async function runStructuralGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	ready: SummaryReadyOperation,
): Promise<ProcedureResult> {
	const preparation = await readAttemptPreparation(lane, drive, ready);
	if (preparation.kind === "cancel_requested") return { kind: "continue" };
	const identity = ready.summaryContext.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) {
		return publishStructuralOutcome(lane, drive, ready, {
			kind: "failed",
			error: operationError("model_unavailable", "The configured model is unavailable in this process", identity),
		});
	}
	const intent = await publishAttemptIntent(lane, drive, ready);
	if (intent.kind === "cancel_requested") return { kind: "continue" };
	const result = await performStructuralAttempt(lane, drive, intent.value, model, preparation.value);
	return publishAttemptResult(lane, drive, intent.value, result);
}

/** Consume one structural retry wait without starting a provider effect. */
export async function runStructuralRetryWait<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	retry: SummaryRetryWaitOperation,
): Promise<ProcedureResult> {
	if (Date.now() < retry.notBefore) {
		if (!drive.waitForRetry) {
			return {
				kind: "waiting",
				outcome: {
					kind: "waiting",
					operationId: drive.operationId,
					reason: "retry",
					notBefore: retry.notBefore,
				},
			};
		}
		await drive.gate.admit(() => waitUntil(retry.notBefore, drive.gate.signal));
	}
	const published = await lane.continueOperation(
		retry,
		(_state, current) => {
			const ready = readyFromRetryWait(current);
			return {
				kind: "commit",
				writes: [],
				operationState: ready,
				materialize: () => ({ kind: "continue" }) as const,
				events: () => [
					{
						type: "retry_start",
						lane: lane.name,
						runId: drive.operationId,
						step: current.task.taskId,
						attempt: current.nextAttempt,
					},
				],
			};
		},
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

/** Convert an orphaned structural attempt into a fresh numbered attempt or terminal failure. */
export async function recoverStructuralGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: SummaryEffectPendingOperation,
): Promise<ProcedureResult> {
	const error = operationError(
		"structural_interrupted",
		"Structural summary attempt was interrupted and its external outcome is unknown",
	);
	if (effect.attempt >= effect.summaryContext.retryPolicy.maxAttempts) {
		return publishStructuralOutcome(lane, drive, effect, { kind: "failed", error });
	}
	const retryWait = retryWaitFromEffect(effect, error.message);
	const published = await lane.continueOperation(
		effect,
		() => ({
			kind: "commit",
			writes: [],
			operationState: retryWait,
			materialize: () => ({ kind: "continue" }) as const,
			events: () => [
				{
					type: "retry_scheduled",
					lane: lane.name,
					runId: drive.operationId,
					step: effect.task.taskId,
					attempt: retryWait.nextAttempt,
					maxAttempts: effect.summaryContext.retryPolicy.maxAttempts,
					delayMs: retryDelay(effect.summaryContext.retryPolicy.baseDelayMs, effect.attempt),
					notBefore: retryWait.notBefore,
					errorMessage: error.message,
					recovery: true,
				},
			],
		}),
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

/** Prepare threshold compaction only when no newer compaction already guards this trigger. */
export async function prepareCompactionThreshold<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: CheckpointOperation,
): Promise<ContinueOperationResult<{ taskId: string; preparation: DurableStructuralPreparation } | undefined>> {
	const settings = checkpoint.settings.compaction;
	const identity = lane.state.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (!settings.enabled || model === undefined) return { kind: "result", value: undefined };
	const path = await readBoundedEntries(lane, drive, checkpoint);
	if (path.kind === "cancel_requested") return path;
	const triggerIndex = path.value.findIndex((entry) => entry.id === checkpoint.triggerEntryId);
	let newestCompactionIndex = -1;
	for (let index = path.value.length - 1; index >= 0; index--) {
		if (path.value[index]!.type === "compaction") {
			newestCompactionIndex = index;
			break;
		}
	}
	if (newestCompactionIndex >= triggerIndex && newestCompactionIndex !== -1) {
		return { kind: "result", value: undefined };
	}
	if (triggerIndex === -1) {
		throw new SessionInvariantError(`Checkpoint trigger ${checkpoint.triggerEntryId} is missing from its Branch`);
	}
	const prepared = prepareCompaction(path.value, settings);
	if (!prepared.ok) throw prepared.error;
	if (prepared.value === undefined || !shouldCompact(prepared.value.tokensBefore, model.contextWindow, settings)) {
		return { kind: "result", value: undefined };
	}
	return {
		kind: "result",
		value: { taskId: lane.session.idGenerator.next(), preparation: durableCompactionPreparation(prepared.value) },
	};
}

/** Prepare one overflow compaction before the response settlement transaction. */
export async function prepareOverflowCompaction<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: AssistantEffectPendingOperation,
): Promise<{ taskId: string; preparation: DurableStructuralPreparation } | undefined> {
	if (generation.generationContext.overflowRecoveryUsed) return undefined;
	const path = await readBoundedEntries(lane, drive, generation);
	if (path.kind === "cancel_requested") return undefined;
	const prepared = prepareCompaction(path.value, generation.settings.compaction);
	if (!prepared.ok) throw prepared.error;
	if (prepared.value === undefined) return undefined;
	return {
		taskId: lane.session.idGenerator.next(),
		preparation: durableCompactionPreparation(prepared.value),
	};
}

/** Atomically move an unsummarized navigation and finish its operation. */
export function commitNavigation<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	navigation: NavigationReadyToCommitOperation,
): Promise<ProcedureResult> {
	return lane
		.continueOperation(
			navigation,
			async (_state, current, meta, reader) => {
				if (
					current.targetId !== null &&
					!(await reader.getEntries([current.targetId], drive.context)).has(current.targetId)
				) {
					throw new SessionInvariantError(`Navigation target ${current.targetId} is missing`);
				}
				if (current.targetId === meta.sourceTipId) {
					throw new SessionInvariantError("Navigation target must differ from its source tip");
				}
				if (current.targetId === null && current.label !== undefined) {
					throw new SessionInvariantError("Root navigation cannot set a label");
				}
				const writes: Write[] = [setValue(branchTip(lane.name), current.targetId)];
				if (current.label !== undefined && current.targetId !== null) {
					writes.push(setValue(entryLabel(current.targetId), current.label));
				}
				const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
				const record = operationResultRecord(meta, "completed", current.targetId);
				return {
					kind: "finish",
					writes: [...writes, ...cleanup],
					record,
					lane: { tipId: current.targetId },
					materialize: () => ({ kind: "settled", outcome: record }) as const,
					events: () => [
						{
							type: "navigation_end",
							lane: lane.name,
							runId: drive.operationId,
							status: "completed",
							fromTipId: meta.sourceTipId,
							tipId: current.targetId,
							endedAt: record.endedAt,
						},
					],
				};
			},
			drive.context,
		)
		.then((result) => (result.kind === "cancel_requested" ? { kind: "continue" } : result.value));
}
