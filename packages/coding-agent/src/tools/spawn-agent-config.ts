import type { ThinkingLevel } from "@kennyfrc/mu-agent-core";
import { type Api, type Model, supportsXhigh } from "@kennyfrc/mu-ai";
import { getEffectiveThinkingLevel } from "../tui/thinking-levels.js";

export type SpawnAgentReasoning = "inherit" | ThinkingLevel;

export interface ResolveSpawnAgentRequestInput {
	parentModel: Model<Api>;
	parentThinkingLevel: ThinkingLevel;
	message: string;
	reasoning?: SpawnAgentReasoning;
}

export interface ResolvedSpawnAgentRequest {
	message: string;
	effectiveModel: Model<Api>;
	requestedReasoning: SpawnAgentReasoning | null;
	effectiveReasoning: ThinkingLevel;
}

export function resolveSpawnAgentRequest(input: ResolveSpawnAgentRequestInput): ResolvedSpawnAgentRequest {
	const effectiveModel = input.parentModel;
	const requestedReasoning = input.reasoning ?? "inherit";
	const baseReasoning = requestedReasoning === "inherit" ? input.parentThinkingLevel : requestedReasoning;
	const effectiveReasoning = getEffectiveThinkingLevel(
		baseReasoning,
		effectiveModel.reasoning,
		supportsXhigh(effectiveModel),
	);

	return {
		message: input.message,
		effectiveModel,
		requestedReasoning: input.reasoning ?? null,
		effectiveReasoning,
	};
}
