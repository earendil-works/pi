import { type AssistantMessage, reduceAssistantMessageFrames } from "@earendil-works/pi-ai";
import type {
	AssistantEffectPendingOperation,
	DeferredEffectPendingOperation,
	LaneConfiguration,
	SettledAssistantMessage,
} from "../../session/types.ts";
import type { Lane } from "../lane.ts";
import { readAssistantFrames } from "../progress.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import { publishResponse } from "./response.ts";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function interruptedAssistantMessage(
	identity: LaneConfiguration["model"],
	partial: AssistantMessage | undefined,
): SettledAssistantMessage {
	const warning =
		"Assistant request was interrupted. The preceding content is the latest committed partial; newer live output may be missing and the external outcome is unknown.";
	return partial === undefined
		? {
				role: "assistant",
				content: [],
				api: "unknown",
				provider: identity.provider,
				model: identity.modelId,
				usage: ZERO_USAGE,
				stopReason: "error",
				errorMessage: warning,
				timestamp: Date.now(),
			}
		: { ...partial, usage: ZERO_USAGE, stopReason: "error", errorMessage: warning };
}

/** Settle an orphaned assistant request from its bounded committed frame prefix without another provider call. */
export async function recoverAssistantGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: AssistantEffectPendingOperation,
): Promise<ProcedureResult> {
	const frames = await lane.continueOperation(
		generation,
		async (_state, _current, _meta, reader) => ({
			kind: "return",
			result: await readAssistantFrames(reader, drive.operationId, generation.responseEntryId, drive.context),
		}),
		drive.context,
	);
	if (frames.kind === "cancel_requested") return { kind: "continue" };

	const message = interruptedAssistantMessage(
		generation.generationContext.configuration.model,
		reduceAssistantMessageFrames(frames.value),
	);
	await lane.emitBatch(
		[
			{
				type: "message_start",
				lane: lane.name,
				runId: drive.operationId,
				message,
				recovery: true,
			},
			{
				type: "message_end",
				lane: lane.name,
				runId: drive.operationId,
				message,
				entryId: generation.responseEntryId,
				recovery: true,
			},
		],
		drive.context,
	);
	return publishResponse(lane, drive, generation, message, { recovery: true });
}

/** Synthetically settle one cancelled orphaned assistant or deferred effect under its reserved ids. */
export async function recoverCancelledAssistantEffect<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: AssistantEffectPendingOperation | DeferredEffectPendingOperation,
): Promise<ProcedureResult> {
	const frames = await lane.settleOperation(
		effect,
		async (_state, _current, _meta, reader) => ({
			kind: "return",
			result: await readAssistantFrames(reader, drive.operationId, effect.responseEntryId, drive.context),
		}),
		drive.context,
	);
	const identity =
		effect.at === "assistant.effect_pending"
			? effect.generationContext.configuration.model
			: effect.configuration.model;
	const message = interruptedAssistantMessage(identity, reduceAssistantMessageFrames(frames));
	await lane.emitBatch(
		[
			{
				type: "message_start",
				lane: lane.name,
				runId: drive.operationId,
				message,
				recovery: true,
			},
			{
				type: "message_end",
				lane: lane.name,
				runId: drive.operationId,
				message,
				entryId: effect.responseEntryId,
				recovery: true,
			},
		],
		drive.context,
	);
	return publishResponse(lane, drive, effect, message, { recovery: true });
}
