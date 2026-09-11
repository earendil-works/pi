import type { Api, DeferredHandle, Model } from "@earendil-works/pi-ai";
import { type Context, getTelemetryContext, withAbortSignal } from "../../context.ts";
import { consumeAssistantStream } from "../../execution/assistant.ts";
import { applyStreamOptionsPatch } from "../../hooks.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type DeferredEffectPendingOperation,
	type DeferredSuspendedOperation,
	type LaneConfiguration,
	type OperationError,
	type OperationScope,
	operationScopeOf,
	type SessionReader,
	type SettledAssistantMessage,
} from "../../session/types.ts";
import { deleteList, pendingAssistantFrames } from "../../session/values.ts";
import type { AgentHarnessStreamOptions } from "../../types.ts";
import type { Lane } from "../lane.ts";
import type { ContinueOperationResult, Drive, ProcedureResult } from "../types.ts";
import { openAssistantResponse, publishConfigurationFailure, publishResponse } from "./response.ts";

type DeferredLeaf = DeferredSuspendedOperation | DeferredEffectPendingOperation;
/** Deferred effect payload without the run-wide scope fields. */
type EffectPendingFields = Omit<DeferredEffectPendingOperation, keyof OperationScope>;

type PreparedDeferredPoll = {
	kind: "ready";
	source: DeferredHandle;
	model: Model<Api>;
	poll: number;
	streamOptions: AgentHarnessStreamOptions;
};

type DeferredPreparation =
	| PreparedDeferredPoll
	| { kind: "cancel_requested" }
	| { kind: "waiting"; source: DeferredHandle }
	| { kind: "configuration_failure" };

function configurationError(identity: LaneConfiguration["model"]): OperationError {
	return {
		code: "model_unavailable",
		message: "The configured model is unavailable in this process",
		details: identity,
	};
}

export async function readDeferredSourceHandle(
	reader: SessionReader,
	deferred: DeferredLeaf,
	context: Context,
): Promise<DeferredHandle> {
	const source = (await reader.getEntries([deferred.sourceEntryId], context)).get(deferred.sourceEntryId);
	if (
		source?.type !== "message" ||
		source.message.role !== "assistant" ||
		source.message.stopReason !== "deferred" ||
		source.message.deferred === undefined
	) {
		throw new SessionInvariantError(`Deferred source ${deferred.sourceEntryId} is missing its assistant handle`);
	}
	const handle = source.message.deferred;
	const identity = deferred.configuration.model;
	if (
		handle.id.length === 0 ||
		handle.provider !== identity.provider ||
		handle.modelId !== identity.modelId ||
		handle.api !== source.message.api
	) {
		throw new SessionInvariantError(`Deferred source ${deferred.sourceEntryId} has an invalid handle`);
	}
	return handle;
}

async function readSourceHandle<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredLeaf,
): Promise<ContinueOperationResult<DeferredHandle>> {
	return lane.continueOperation(
		deferred,
		async (_state, _current, _meta, reader) => ({
			kind: "return",
			result: await readDeferredSourceHandle(reader, deferred, drive.context),
		}),
		drive.context,
	);
}

async function prepareDeferredPoll<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	expected: DeferredLeaf,
): Promise<DeferredPreparation> {
	const source = await readSourceHandle(lane, drive, expected);
	if (source.kind === "cancel_requested") return source;
	if (drive.deferredPermits === 0) return { kind: "waiting", source: source.value };

	const identity = expected.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) return { kind: "configuration_failure" };
	const baseOptions: AgentHarnessStreamOptions = { ...expected.streamOptions, deferred: false };
	const poll = expected.at === "deferred.suspended" ? expected.poll + 1 : expected.poll;
	const beforeRequest = await lane.hooks.runWithGate(
		"before_request",
		{
			lane: lane.name,
			runId: drive.operationId,
			model,
			step: "deferred",
			attempt: poll,
			streamOptions: baseOptions,
		},
		drive.gate,
		drive.context,
	);
	return {
		kind: "ready",
		source: source.value,
		model,
		poll,
		streamOptions: {
			...(beforeRequest?.streamOptions === undefined
				? baseOptions
				: applyStreamOptionsPatch(baseOptions, beforeRequest.streamOptions)),
			deferred: false,
		},
	};
}

async function publishPollIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredLeaf,
	prepared: PreparedDeferredPoll,
	recovery: boolean,
): Promise<ContinueOperationResult<DeferredEffectPendingOperation>> {
	const at = Date.now();
	const next: EffectPendingFields = {
		at: "deferred.effect_pending",
		stepId: deferred.stepId,
		sourceEntryId: deferred.sourceEntryId,
		poll: prepared.poll,
		responseEntryId: lane.session.idGenerator.next(at),
		usageId: lane.session.idGenerator.next(at),
		configuration: deferred.configuration,
		streamOptions: deferred.streamOptions,
	};
	return lane.continueOperation(
		deferred,
		(_state, current) => {
			const nextState: DeferredEffectPendingOperation = { ...operationScopeOf(current), ...next };
			return {
				kind: "commit",
				writes:
					deferred.at === "deferred.effect_pending"
						? [deleteList(pendingAssistantFrames(drive.operationId, deferred.responseEntryId))]
						: [],
				operationState: nextState,
				materialize: () => {
					drive.deferredPermits--;
					return nextState;
				},
				events: () => [
					{
						type: "run_resume",
						lane: lane.name,
						runId: drive.operationId,
						...(recovery ? { recovery: true as const } : {}),
					},
					{
						type: "turn_start",
						lane: lane.name,
						runId: drive.operationId,
						turnId: `${next.stepId}:poll:${next.poll}`,
						...(recovery ? { recovery: true as const } : {}),
					},
				],
			};
		},
		drive.context,
	);
}

async function performDeferredPoll<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	prepared: PreparedDeferredPoll,
	intent: DeferredEffectPendingOperation,
	recovery: boolean,
): Promise<SettledAssistantMessage> {
	const response = openAssistantResponse(lane, drive, intent.responseEntryId, recovery);
	let metadata: { status?: number; headers?: Record<string, string> } = {};
	const admitted = withAbortSignal(drive.gate.signal, drive.context);
	const stream = drive.gate.admit(() =>
		lane.models.streamDeferred(prepared.model, prepared.source, {
			wait: 0,
			signal: admitted.abortSignal,
			telemetryContext: getTelemetryContext(admitted),
			timeoutMs: prepared.streamOptions.timeoutMs,
			maxRetries: prepared.streamOptions.maxRetries,
			maxRetryDelayMs: prepared.streamOptions.maxRetryDelayMs,
			headers: prepared.streamOptions.headers,
			onPayload: async (payload, requestModel) => {
				const result = await lane.hooks.runWithGate(
					"before_payload",
					{ lane: lane.name, runId: drive.operationId, model: requestModel, payload },
					drive.gate,
					drive.context,
				);
				return result?.payload;
			},
			onResponse: (response) => {
				metadata = { status: response.status, headers: response.headers };
			},
		}),
	);

	try {
		return await consumeAssistantStream(
			stream,
			response.observer,
			(message, context) => response.afterResponse(message, metadata, context),
			drive.context,
		);
	} finally {
		await response.close();
	}
}

async function pollDeferred<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	expected: DeferredLeaf,
	recovery: boolean,
): Promise<ProcedureResult> {
	const prepared = await prepareDeferredPoll(lane, drive, expected);
	if (prepared.kind === "cancel_requested") return { kind: "continue" };
	if (prepared.kind === "waiting") {
		return {
			kind: "waiting",
			outcome: {
				kind: "waiting",
				operationId: drive.operationId,
				reason: "deferred",
				deferred: prepared.source,
			},
		};
	}
	if (prepared.kind === "configuration_failure") {
		return publishConfigurationFailure(lane, drive, expected, configurationError(expected.configuration.model));
	}

	const intent = await publishPollIntent(lane, drive, expected, prepared, recovery);
	if (intent.kind === "cancel_requested") return { kind: "continue" };
	const response = await performDeferredPoll(lane, drive, prepared, intent.value, recovery);
	return publishResponse(lane, drive, intent.value, response, recovery ? { recovery: true } : {});
}

/** Poll one durably suspended deferred response when this pass carries a permit. */
export function runDeferredSuspended<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredSuspendedOperation,
): Promise<ProcedureResult> {
	return pollDeferred(lane, drive, deferred, false);
}

/** Replace one orphaned unknown-outcome poll under fresh ids when this pass carries a permit. */
export function recoverDeferredPoll<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredEffectPendingOperation,
): Promise<ProcedureResult> {
	return pollDeferred(lane, drive, deferred, true);
}

/** Advance or report the wait for one deferred run phase. */
export function runDeferred<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredSuspendedOperation | DeferredEffectPendingOperation,
): Promise<ProcedureResult> {
	return deferred.at === "deferred.suspended"
		? runDeferredSuspended(lane, drive, deferred)
		: recoverDeferredPoll(lane, drive, deferred);
}
