import type { DeferredHandle } from "@earendil-works/pi-ai";
import type { HarnessEvent } from "../../agent-harness.ts";
import { getTelemetryContext } from "../../context.ts";
import { SessionInvariantError } from "../../session/session.ts";
import type {
	DeferredEffectPendingOperation,
	DeferredSuspendedOperation,
	OperationState,
} from "../../session/types.ts";
import type { Lane } from "../lane.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import { readDeferredSourceHandle } from "./deferred.ts";
import { recoverCancelledAssistantEffect } from "./recovery.ts";
import { operationCleanupWrites, operationResultRecord } from "./terminal.ts";
import { runTools } from "./tools.ts";

async function cancelDeferredBestEffort<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredSuspendedOperation | DeferredEffectPendingOperation,
	handle: DeferredHandle,
): Promise<void> {
	const identity = deferred.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) return;
	try {
		await lane.models.cancelDeferred(model, handle, {
			signal: drive.closeSignal,
			telemetryContext: getTelemetryContext(drive.context),
			timeoutMs: deferred.streamOptions.timeoutMs,
			maxRetries: deferred.streamOptions.maxRetries,
			maxRetryDelayMs: deferred.streamOptions.maxRetryDelayMs,
			headers: deferred.streamOptions.headers,
		});
	} catch {
		// Remote cancellation is best-effort; durable local reconciliation must continue.
	}
}

async function readDeferredHandle<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredSuspendedOperation | DeferredEffectPendingOperation,
): Promise<DeferredHandle> {
	return lane.settleOperation(
		deferred,
		async (_state, _current, _meta, reader) => ({
			kind: "return",
			result: await readDeferredSourceHandle(reader, deferred, drive.context),
		}),
		drive.context,
	);
}

async function publishAbortedTerminal<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: OperationState,
): Promise<ProcedureResult> {
	return lane.settleOperation(
		capability,
		async (state, current, meta, reader) => {
			if (current.control.status !== "cancel_requested") {
				throw new SessionInvariantError("Cancellation reconciliation requires cancelled durable control");
			}
			const record = operationResultRecord(meta, "aborted", state.tipId);
			const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			const events: HarnessEvent[] = [];
			if (meta.intent.kind === "run") {
				switch (current.at) {
					case "summary.deciding":
					case "summary.ready":
					case "summary.effect_pending":
					case "summary.retry_wait":
						if (current.task.boundary.kind !== "resume_checkpoint" || current.task.reason === undefined) {
							throw new SessionInvariantError("Cancelled run summary has an invalid result boundary");
						}
						events.push({
							type: "compaction_end",
							lane: lane.name,
							runId: drive.operationId,
							reason: current.task.reason,
							status: "aborted",
							endedAt: record.endedAt,
						});
						break;
					default:
						break;
				}
				events.push({
					type: "run_end",
					lane: lane.name,
					runId: drive.operationId,
					status: "aborted",
					fromTipId: meta.sourceTipId,
					tipId: state.tipId,
					endedAt: record.endedAt,
				});
			} else if (meta.intent.kind === "compaction") {
				events.push({
					type: "compaction_end",
					lane: lane.name,
					runId: drive.operationId,
					reason: "manual",
					status: "aborted",
					endedAt: record.endedAt,
				});
			} else {
				events.push({
					type: "navigation_end",
					lane: lane.name,
					runId: drive.operationId,
					status: "aborted",
					fromTipId: meta.sourceTipId,
					tipId: state.tipId,
					endedAt: record.endedAt,
				});
			}
			return {
				kind: "finish",
				writes: cleanup,
				record,
				materialize: () => ({ kind: "settled", outcome: record }) as const,
				events: () => events,
			};
		},
		drive.context,
	);
}

/** Advance one cancelled durable leaf without starting new ordinary work. */
export async function reconcileOperation<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
): Promise<ProcedureResult> {
	const operation = lane.state.operation;
	if (operation === null || operation.meta.operationId !== drive.operationId) {
		throw new SessionInvariantError(`Drive ${drive.operationId} has no matching operation to reconcile`);
	}
	if (operation.state.control.status !== "cancel_requested") {
		throw new SessionInvariantError(`Operation ${drive.operationId} is not cancelled`);
	}
	drive.beginAbort(Promise.resolve());
	drive.signalAbort();

	const state = operation.state;
	switch (state.at) {
		case "assistant.effect_pending":
			return recoverCancelledAssistantEffect(lane, drive, state);
		case "tools":
			return runTools(lane, drive, state);
		case "deferred.suspended": {
			const handle = await readDeferredHandle(lane, drive, state);
			await cancelDeferredBestEffort(lane, drive, state, handle);
			return publishAbortedTerminal(lane, drive, state);
		}
		case "deferred.effect_pending": {
			const handle = await readDeferredHandle(lane, drive, state);
			await cancelDeferredBestEffort(lane, drive, state, handle);
			return recoverCancelledAssistantEffect(lane, drive, state);
		}
		case "starting":
		case "checkpoint":
		case "assistant.ready":
		case "assistant.retry_wait":
		case "summary.deciding":
		case "summary.ready":
		case "summary.effect_pending":
		case "summary.retry_wait":
		case "navigation.ready_to_commit":
			return publishAbortedTerminal(lane, drive, state);
	}
}
