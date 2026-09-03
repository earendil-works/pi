import {
	type AssistantMessageEvent,
	AssistantMessageFrameEncoder,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import type { HarnessEvent } from "../../agent-harness.ts";
import type { Context } from "../../context.ts";
import type { AssistantResponseMetadata, AssistantStreamObserver } from "../../execution/assistant.ts";
import { insertEntry, insertUsage } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type AssistantEffectPendingOperation,
	type CommitResult,
	type DeferredEffectPendingOperation,
	type MessageEntry,
	type NewEntry,
	type OperationError,
	type OperationState,
	operationScopeOf,
	type SettledAssistantMessage,
	type SummaryDecidingOperation,
	type ToolCall,
	type UsageRow,
} from "../../session/types.ts";
import { branchTip, deleteList, operationPreparation, pendingAssistantFrames, setValue } from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import { openFrameProgress } from "../progress.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import { retryDelay, retryNotBefore } from "./retry.ts";
import { prepareOverflowCompaction } from "./structural.ts";
import { operationCleanupWrites, operationResultRecord } from "./terminal.ts";

export type AssistantResponseLifecycle = {
	observer: AssistantStreamObserver;
	afterResponse(
		message: SettledAssistantMessage,
		metadata: AssistantResponseMetadata,
		context: Context,
	): Promise<SettledAssistantMessage>;
	close(): Promise<void>;
};

export function openAssistantResponse<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	responseEntryId: string,
	recovery = false,
): AssistantResponseLifecycle {
	const progress = openFrameProgress(lane, drive, responseEntryId);
	const frameEncoder = new AssistantMessageFrameEncoder();
	const eventContext = {
		lane: lane.name,
		runId: drive.operationId,
		...(recovery ? { recovery: true as const } : {}),
	};
	const close = async () => {
		progress.seal();
		await progress.drain();
	};
	return {
		observer: {
			start(message, event, context) {
				const frame = frameEncoder.encode(event);
				if (frame !== undefined) progress.write(frame);
				return lane.emitBatch([{ type: "message_start", ...eventContext, message }], context);
			},
			update(message, event: AssistantMessageEvent, context) {
				const frame = frameEncoder.encode(event);
				if (frame !== undefined) progress.write(frame);
				return lane.emitBatch(
					[{ type: "message_update", ...eventContext, message, event, ...(frame === undefined ? {} : { frame }) }],
					context,
				);
			},
			end(message, context) {
				return lane.emitBatch(
					[{ type: "message_end", ...eventContext, message, entryId: responseEntryId }],
					context,
				);
			},
		},
		async afterResponse(message, metadata, context) {
			await close();
			const result = await lane.hooks.runWithGate(
				"after_response",
				{ lane: lane.name, runId: drive.operationId, ...metadata, message },
				drive.gate,
				context,
			);
			return result?.message ?? message;
		},
		close,
	};
}

type ResponseIntent = AssistantEffectPendingOperation | DeferredEffectPendingOperation;
type ConfigurationFailureState = Extract<
	OperationState,
	{ at: "assistant.ready" | "assistant.retry_wait" | "deferred.suspended" | "deferred.effect_pending" }
>;

/** Publish a non-retryable request-configuration failure before reserving response ids. */
export async function publishConfigurationFailure<
	TContext extends object | undefined,
	TState extends ConfigurationFailureState,
>(lane: Lane<TContext>, drive: Drive, capability: TState, error: OperationError): Promise<ProcedureResult> {
	const result = await lane.continueOperation(
		capability,
		async (state, current, meta, reader) => {
			if (state.tipId === null) throw new SessionInvariantError("Failed run has no Branch tip");
			const record = operationResultRecord(meta, "failed", state.tipId, error);
			const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			return {
				kind: "finish",
				writes: cleanup,
				record,
				materialize: () => ({ kind: "settled", outcome: record }) as const,
				events: () => [
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
		},
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

function uuidV7Timestamp(id: string): number {
	const timestamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
	if (!Number.isSafeInteger(timestamp)) throw new SessionInvariantError(`Invalid reserved UUIDv7 ${id}`);
	return timestamp;
}

function providerError(source: "assistant" | "deferred", message: SettledAssistantMessage): OperationError {
	return {
		code: "assistant_error",
		message:
			message.errorMessage ??
			`${source === "assistant" ? "Assistant" : "Deferred"} request ended with ${message.stopReason}`,
	};
}

function normalizeError(message: SettledAssistantMessage, errorMessage: string): SettledAssistantMessage {
	return { ...message, stopReason: "error", errorMessage };
}

function normalizeAborted(source: "assistant" | "deferred", message: SettledAssistantMessage): SettledAssistantMessage {
	return {
		...message,
		stopReason: "aborted",
		errorMessage:
			message.errorMessage ?? `${source === "assistant" ? "Assistant" : "Deferred"} request was cancelled`,
	};
}

function deferredHandleIsValid(message: SettledAssistantMessage, generation: AssistantEffectPendingOperation): boolean {
	const handle = message.deferred;
	const identity = generation.generationContext.configuration.model;
	return (
		message.stopReason === "deferred" &&
		handle !== undefined &&
		handle.id.length !== 0 &&
		handle.provider === identity.provider &&
		handle.modelId === identity.modelId &&
		handle.api === message.api
	);
}

/** Classify and atomically settle one assistant-generation or deferred-poll response. */
export async function publishResponse<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	intent: ResponseIntent,
	response: SettledAssistantMessage,
	options: { recovery?: true } = {},
): Promise<ProcedureResult> {
	const overflow =
		intent.at === "assistant.effect_pending" &&
		(isContextOverflow(response, intent.contextWindow) || isRecoverableLength(response, intent.intendedOutputLimit));
	const overflowPreparation =
		overflow && !intent.generationContext.overflowRecoveryUsed
			? await prepareOverflowCompaction(lane, drive, intent)
			: undefined;
	return lane.settleOperation<ResponseIntent, ProcedureResult>(
		intent,
		async (state, current, meta, reader) => {
			const source = current.at === "assistant.effect_pending" ? "assistant" : "deferred";
			const responseEntryId = intent.responseEntryId;
			const configuration =
				current.at === "assistant.effect_pending" ? current.generationContext.configuration : current.configuration;
			const turnId =
				current.at === "assistant.effect_pending"
					? current.generationContext.stepId
					: `${current.stepId}:poll:${current.poll}`;
			const scope = { ...operationScopeOf(current), latestAssistantEntryId: responseEntryId };
			let committed = response;
			let settled: OperationState | undefined;
			let failure: OperationError | undefined;

			if (current.control.status === "cancel_requested") {
				committed = normalizeAborted(source, response);
				settled = {
					...scope,
					at: "checkpoint",
					continuation: { kind: "may_finish", includeFinalAssistant: true },
					triggerEntryId: responseEntryId,
				};
			} else if (response.stopReason === "aborted") {
				throw new SessionInvariantError(
					`${source === "assistant" ? "Assistant" : "Deferred"} response is aborted while durable control is running`,
				);
			} else if (current.at === "assistant.effect_pending" && overflow) {
				committed = normalizeError(
					response,
					response.errorMessage ?? "Assistant request exceeded the context window",
				);
				if (current.generationContext.overflowRecoveryUsed || overflowPreparation === undefined) {
					failure = providerError(source, committed);
				} else {
					const structural: SummaryDecidingOperation = {
						...scope,
						at: "summary.deciding",
						task: {
							taskId: overflowPreparation.taskId,
							reason: "overflow",
							boundary: {
								kind: "resume_checkpoint",
								resumeAfter: {
									continuation: { kind: "need_assistant", overflowRecoveryUsed: true },
									triggerEntryId: current.generationContext.triggerEntryId,
								},
							},
						},
					};
					settled = structural;
				}
			} else if (response.stopReason === "deferred") {
				if (current.at === "assistant.effect_pending") {
					if (deferredHandleIsValid(response, current)) {
						settled = {
							...scope,
							at: "deferred.suspended",
							stepId: current.generationContext.stepId,
							sourceEntryId: responseEntryId,
							poll: 0,
							configuration,
							streamOptions: current.generationContext.streamOptions,
						};
					} else {
						committed = normalizeError(response, "Provider returned an invalid deferred handle");
						failure = providerError(source, committed);
					}
				} else {
					settled = {
						...scope,
						at: "deferred.suspended",
						stepId: current.stepId,
						sourceEntryId: responseEntryId,
						poll: current.poll,
						configuration,
						streamOptions: current.streamOptions,
					};
				}
			} else if (response.stopReason === "error") {
				if (
					current.at === "assistant.effect_pending" &&
					(options.recovery === true || isRetryableAssistantError(response)) &&
					current.attempt < current.generationContext.retryPolicy.maxAttempts
				) {
					settled = {
						...scope,
						at: "assistant.retry_wait",
						generationContext: current.generationContext,
						nextAttempt: current.attempt + 1,
						notBefore: retryNotBefore(current.generationContext.retryPolicy.baseDelayMs, current.attempt),
						errorMessage: response.errorMessage ?? "Assistant request failed",
					};
				} else {
					failure = providerError(source, response);
				}
			} else {
				const calls = response.content.flatMap((content, sourceIndex) =>
					content.type === "toolCall" ? [{ sourceIndex }] : [],
				);
				if (calls.length !== 0) {
					const timestamp = uuidV7Timestamp(responseEntryId);
					const planned: ToolCall[] = calls.map(({ sourceIndex }) => ({
						status: "planned",
						sourceIndex,
						resultEntryId: lane.session.idGenerator.next(timestamp),
					}));
					settled = {
						...scope,
						at: "tools",
						batch: { assistantEntryId: responseEntryId, configuration, turnId, calls: planned },
					};
				} else if (response.stopReason === "toolUse") {
					committed = normalizeError(response, "Provider reported tool use without any tool calls");
					failure = providerError(source, committed);
				} else {
					settled = {
						...scope,
						at: "checkpoint",
						continuation: { kind: "may_finish", includeFinalAssistant: true },
						triggerEntryId: responseEntryId,
					};
				}
			}

			const responseEntry: NewEntry<MessageEntry> = {
				id: responseEntryId,
				parentId: state.tipId,
				type: "message",
				message: committed,
			};
			const usageRow: Omit<UsageRow, "seq"> = {
				id: intent.usageId,
				usage: committed.usage,
				entryId: responseEntryId,
				adjustment: false,
			};
			if (settled === undefined && failure === undefined) {
				throw new SessionInvariantError("Response settlement has no durable disposition");
			}
			const record =
				failure === undefined ? undefined : operationResultRecord(meta, "failed", responseEntryId, failure);
			const cleanup =
				record === undefined ? [] : await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			const writes = [
				insertEntry(responseEntry),
				insertUsage(usageRow),
				setValue(branchTip(lane.name), responseEntryId),
				...(record === undefined
					? [deleteList(pendingAssistantFrames(drive.operationId, responseEntryId))]
					: cleanup),
				...(settled?.at === "summary.deciding" && overflowPreparation !== undefined
					? [
							setValue(
								operationPreparation(drive.operationId, overflowPreparation.taskId),
								overflowPreparation.preparation,
							),
						]
					: []),
			];
			const materializeEntry = (commit: CommitResult): MessageEntry => ({
				...responseEntry,
				seq: commit.seqs[0]!,
				timestamp: commit.timestamp,
			});
			const events = (commit: CommitResult): HarnessEvent[] => {
				const entry = materializeEntry(commit);
				const batch: HarnessEvent[] = [
					{ type: "entry_added", lane: lane.name, entry, ...options },
					{
						type: "usage",
						lane: lane.name,
						row: { ...usageRow, seq: commit.seqs[1]! },
						totals: commit.stats.usage,
					},
				];
				if (current.at === "assistant.effect_pending") {
					if (options.recovery !== true && current.attempt > 1 && settled?.at !== "assistant.retry_wait") {
						const success = committed.stopReason !== "error" && committed.stopReason !== "aborted";
						batch.push({
							type: "retry_end",
							lane: lane.name,
							runId: drive.operationId,
							step: turnId,
							attempt: current.attempt,
							success,
							...(success
								? {}
								: {
										finalError:
											committed.errorMessage ?? `Assistant request ended with ${committed.stopReason}`,
									}),
						});
					}
					if (options.recovery !== true && settled?.at === "assistant.retry_wait") {
						batch.push({
							type: "retry_scheduled",
							lane: lane.name,
							runId: drive.operationId,
							step: turnId,
							attempt: settled.nextAttempt,
							maxAttempts: settled.generationContext.retryPolicy.maxAttempts,
							delayMs: retryDelay(current.generationContext.retryPolicy.baseDelayMs, current.attempt),
							notBefore: settled.notBefore,
							errorMessage: settled.errorMessage,
						});
					}
					if (options.recovery !== true && settled?.at !== "tools" && settled?.at !== "assistant.retry_wait") {
						batch.push({
							type: "turn_end",
							lane: lane.name,
							runId: drive.operationId,
							turnId,
							message: committed,
							toolResults: [],
						});
					}
					if (settled?.at === "summary.deciding") {
						batch.push({
							type: "compaction_start",
							lane: lane.name,
							runId: drive.operationId,
							reason: "overflow",
							startedAt: commit.timestamp,
						});
					}
				} else if (settled?.at !== "tools") {
					batch.push({
						type: "turn_end",
						lane: lane.name,
						runId: drive.operationId,
						turnId,
						message: committed,
						toolResults: [],
						...options,
					});
				}
				if (
					(current.at === "deferred.effect_pending" || options.recovery !== true) &&
					settled?.at === "deferred.suspended" &&
					committed.deferred !== undefined
				) {
					batch.push({
						type: "run_suspend",
						lane: lane.name,
						runId: drive.operationId,
						reason: "deferred",
						deferred: committed.deferred,
						poll: settled.poll,
						...(current.at === "deferred.effect_pending" ? options : {}),
					});
				}
				if (record !== undefined && failure !== undefined) {
					batch.push({
						type: "run_end",
						lane: lane.name,
						runId: drive.operationId,
						status: "failed",
						error: failure,
						fromTipId: meta.sourceTipId,
						tipId: responseEntryId,
						endedAt: record.endedAt,
					});
				}
				return batch;
			};
			if (record !== undefined) {
				return {
					kind: "finish",
					writes,
					record,
					lane: { tipId: responseEntryId },
					materialize: () => ({ kind: "settled", outcome: record }) as const,
					events,
				};
			}
			if (settled === undefined) throw new SessionInvariantError("Response settlement is missing its next state");
			return {
				kind: "commit",
				writes,
				operationState: settled,
				lane: { tipId: responseEntryId },
				materialize: () => ({ kind: "continue" }) as const,
				events,
			};
		},
		drive.context,
	);
}
