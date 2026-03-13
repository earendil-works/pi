import type { ThinkingLevel } from "@kennyfrc/mu-agent-core";
import { type Api, type Model, supportsXhigh } from "@kennyfrc/mu-ai";
import { findModel } from "../model-config.js";
import { getEffectiveThinkingLevel } from "../tui/thinking-levels.js";

export type SpawnAgentReasoning = "inherit" | ThinkingLevel;

export interface ResolveSpawnAgentRequestInput {
	parentModel: Model<Api>;
	parentThinkingLevel: ThinkingLevel;
	message: string;
	model?: string;
	reasoning?: SpawnAgentReasoning;
}

export interface ResolvedSpawnAgentRequest {
	message: string;
	requestedModel: string | null;
	effectiveModel: Model<Api>;
	requestedReasoning: SpawnAgentReasoning | null;
	effectiveReasoning: ThinkingLevel;
}

function resolveRequestedModel(model: string | undefined, parentModel: Model<Api>): Model<Api> {
	if (!model) {
		return parentModel;
	}

	const slashIndex = model.indexOf("/");
	if (slashIndex <= 0 || slashIndex === model.length - 1) {
		throw new Error(`Invalid model "${model}". Expected provider/modelId.`);
	}

	const provider = model.slice(0, slashIndex);
	const modelId = model.slice(slashIndex + 1);
	const resolved = findModel(provider, modelId);
	if (resolved.error) {
		throw new Error(resolved.error);
	}
	if (!resolved.model) {
		throw new Error(`Model ${model} not found`);
	}
	return resolved.model;
}

export function resolveSpawnAgentRequest(input: ResolveSpawnAgentRequestInput): ResolvedSpawnAgentRequest {
	const effectiveModel = resolveRequestedModel(input.model, input.parentModel);
	const requestedReasoning = input.reasoning ?? "inherit";
	const baseReasoning = requestedReasoning === "inherit" ? input.parentThinkingLevel : requestedReasoning;
	const effectiveReasoning = getEffectiveThinkingLevel(
		baseReasoning,
		effectiveModel.reasoning,
		supportsXhigh(effectiveModel),
	);

	return {
		message: input.message,
		requestedModel: input.model ?? null,
		effectiveModel,
		requestedReasoning: input.reasoning ?? null,
		effectiveReasoning,
	};
}
