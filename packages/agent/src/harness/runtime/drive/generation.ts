import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../../types.ts";
import { type Context, getTelemetryContext, withAbortSignal } from "../../context.ts";
import { type HarnessAssistantStreamConfig, streamHarnessAssistant } from "../../execution/assistant.ts";
import { applyStreamOptionsPatch } from "../../hooks.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type AssistantEffectPendingOperation,
	type AssistantReadyOperation,
	type AssistantRetryWaitOperation,
	type JsonValue,
	type OperationError,
	type OperationScope,
	operationScopeOf,
	type SettledAssistantMessage,
} from "../../session/types.ts";
import type { AgentHarnessStreamOptions } from "../../types.ts";
import type { Lane } from "../lane.ts";
import { readBoundedContext } from "../transcript.ts";
import type { ContinueOperationResult, Drive, ProcedureResult } from "../types.ts";
import { openAssistantResponse, publishConfigurationFailure, publishResponse } from "./response.ts";
import { waitUntil } from "./retry.ts";

/** Assistant effect-pending payload without the run-wide scope fields. */
type AssistantEffectPending = Omit<AssistantEffectPendingOperation, keyof OperationScope>;

type PreparedGeneration = {
	kind: "ready";
	model: Model<Api>;
	tools: Tool[];
	messages: AgentMessage[];
	systemPrompt: string;
	streamOptions: AgentHarnessStreamOptions;
	toProviderMessages: HarnessAssistantStreamConfig["toProviderMessages"];
};

type GenerationPreparation =
	| PreparedGeneration
	| { kind: "configuration_failure"; error: OperationError }
	| { kind: "cancel_requested" };

function configurationError(
	code: "model_unavailable" | "configured_tools_unavailable",
	details: JsonValue,
): OperationError {
	return {
		code,
		message:
			code === "model_unavailable"
				? "The configured model is unavailable in this process"
				: "One or more configured tools are unavailable in this process",
		details,
	};
}

async function resolveSystemPrompt<TContext extends object | undefined>(
	lane: Lane<TContext>,
	context: Context,
): Promise<string> {
	const config = lane.readConfig();
	if (config.systemPrompt === undefined) return "";
	if (typeof config.systemPrompt === "string") return config.systemPrompt;
	const source = config.toolContext;
	const toolContext = typeof source === "function" ? await source(context) : source;
	return config.systemPrompt(toolContext as TContext, context);
}

async function prepareGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: AssistantReadyOperation,
): Promise<GenerationPreparation> {
	const identity = generation.generationContext.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) {
		return { kind: "configuration_failure", error: configurationError("model_unavailable", identity) };
	}

	const config = lane.readConfig();
	const toolsByName = new Map(config.tools.map((tool) => [tool.name, tool]));
	const missingTools = generation.generationContext.configuration.activeToolNames.filter(
		(name) => !toolsByName.has(name),
	);
	if (missingTools.length !== 0) {
		return {
			kind: "configuration_failure",
			error: configurationError("configured_tools_unavailable", { tools: missingTools }),
		};
	}
	const tools: Tool[] = generation.generationContext.configuration.activeToolNames.map((name) => {
		const tool = toolsByName.get(name);
		if (tool === undefined) throw new SessionInvariantError(`Configured tool ${name} disappeared during resolution`);
		return {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
		};
	});

	const messages = await readBoundedContext(lane, drive, generation);
	if (messages.kind === "cancel_requested") return messages;
	const systemPrompt = await resolveSystemPrompt(lane, drive.context);
	const beforeRequest = await lane.hooks.runWithGate(
		"before_request",
		{
			lane: lane.name,
			runId: drive.operationId,
			model,
			step: "assistant",
			attempt: generation.nextAttempt,
			streamOptions: generation.generationContext.streamOptions,
		},
		drive.gate,
		drive.context,
	);
	const streamOptions =
		beforeRequest?.streamOptions === undefined
			? generation.generationContext.streamOptions
			: applyStreamOptionsPatch(generation.generationContext.streamOptions, beforeRequest.streamOptions);
	return {
		kind: "ready",
		model,
		tools,
		messages: messages.value,
		systemPrompt,
		streamOptions,
		toProviderMessages: config.toProviderMessages,
	};
}

async function publishGenerationIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	ready: AssistantReadyOperation,
	prepared: PreparedGeneration,
): Promise<ContinueOperationResult<AssistantEffectPendingOperation>> {
	const at = Date.now();
	const pending: AssistantEffectPending = {
		at: "assistant.effect_pending",
		generationContext: ready.generationContext,
		attempt: ready.nextAttempt,
		responseEntryId: lane.session.idGenerator.next(at),
		usageId: lane.session.idGenerator.next(at),
		intendedOutputLimit: prepared.model.maxTokens,
		contextWindow: prepared.model.contextWindow,
	};
	return lane.continueOperation(
		ready,
		(_state, current) => {
			const nextState: AssistantEffectPendingOperation = { ...operationScopeOf(current), ...pending };
			return {
				kind: "commit",
				writes: [],
				operationState: nextState,
				materialize: () => nextState,
				events: () =>
					ready.nextAttempt === 1
						? [
								{
									type: "turn_start",
									lane: lane.name,
									runId: drive.operationId,
									turnId: ready.generationContext.stepId,
								},
							]
						: [],
			};
		},
		drive.context,
	);
}

async function performGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	intent: AssistantEffectPendingOperation,
	prepared: PreparedGeneration,
): Promise<SettledAssistantMessage> {
	const response = openAssistantResponse(lane, drive, intent.responseEntryId);
	try {
		return await streamHarnessAssistant(
			prepared.messages,
			{
				model: prepared.model,
				systemPrompt: prepared.systemPrompt,
				tools: prepared.tools,
				thinkingLevel: intent.generationContext.configuration.thinkingLevel,
				streamOptions: prepared.streamOptions,
				transformContext: async (requestContext, context) => {
					const result = await lane.hooks.runWithGate(
						"transform_context",
						{ lane: lane.name, runId: drive.operationId, ...requestContext },
						drive.gate,
						context,
					);
					return {
						messages: result?.messages ?? requestContext.messages,
						systemPrompt: result?.systemPrompt ?? requestContext.systemPrompt,
					};
				},
				toProviderMessages: prepared.toProviderMessages,
				beforePayload: async (payload, requestModel, context) => {
					const result = await lane.hooks.runWithGate(
						"before_payload",
						{ lane: lane.name, runId: drive.operationId, model: requestModel, payload },
						drive.gate,
						context,
					);
					return result?.payload;
				},
				afterResponse: response.afterResponse,
				request: (aiContext, options, context) => {
					const admitted = withAbortSignal(drive.gate.signal, context);
					return drive.gate.admit(() =>
						lane.models.streamSimple(prepared.model, aiContext, {
							...options,
							sessionId: `${lane.session.metadata.id}:${lane.name}`,
							signal: admitted.abortSignal,
							telemetryContext: getTelemetryContext(admitted),
						}),
					);
				},
				observer: response.observer,
			},
			drive.context,
		);
	} finally {
		await response.close();
	}
}

/** Advance one durable assistant retry wait according to this pass's local wait policy. */
export async function runRetryWait<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: AssistantRetryWaitOperation,
): Promise<ProcedureResult> {
	if (Date.now() < generation.notBefore) {
		if (!drive.waitForRetry) {
			return {
				kind: "waiting",
				outcome: {
					kind: "waiting",
					operationId: drive.operationId,
					reason: "retry",
					notBefore: generation.notBefore,
				},
			};
		}
		await drive.gate.admit(() => waitUntil(generation.notBefore, drive.gate.signal));
	}

	const result = await lane.continueOperation(
		generation,
		(_state, current) => {
			const nextState: AssistantReadyOperation = {
				...operationScopeOf(current),
				at: "assistant.ready",
				generationContext: generation.generationContext,
				nextAttempt: generation.nextAttempt,
			};
			return {
				kind: "commit",
				writes: [],
				operationState: nextState,
				materialize: () => ({ kind: "continue" }) as const,
				events: () => [
					{
						type: "retry_start",
						lane: lane.name,
						runId: drive.operationId,
						step: generation.generationContext.stepId,
						attempt: generation.nextAttempt,
					},
				],
			};
		},
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

/** Execute one ready assistant generation or advance its durable retry wait. */
export async function runGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: AssistantReadyOperation | AssistantRetryWaitOperation,
): Promise<ProcedureResult> {
	if (generation.at === "assistant.retry_wait") return runRetryWait(lane, drive, generation);

	const prepared = await prepareGeneration(lane, drive, generation);
	if (prepared.kind === "configuration_failure") {
		return publishConfigurationFailure(lane, drive, generation, prepared.error);
	}
	if (prepared.kind === "cancel_requested") return { kind: "continue" };

	const intent = await publishGenerationIntent(lane, drive, generation, prepared);
	if (intent.kind === "cancel_requested") return { kind: "continue" };
	const response = await performGeneration(lane, drive, intent.value, prepared);
	return publishResponse(lane, drive, intent.value, response);
}
