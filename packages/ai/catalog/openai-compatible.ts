// Defaults for OpenAI-compatible hosts whose support for OpenAI-only request
// features has not been verified. Hosts that verify a feature override these.

import type { OpenAICompletionsCompat } from "../src/types.ts";
import type { ModelsDevModel } from "./sources/models-dev.ts";

/** Leave out `store`, developer messages, long cache retention, and `max_completion_tokens`. */
export const OPENAI_COMPATIBLE_HOST_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
	supportsLongCacheRetention: false,
};

/**
 * Send `reasoning_effort` only where models.dev lists effort levels; other
 * reasoning models keep the host's default thinking behavior.
 */
export function catalogedEffortCompat(source: ModelsDevModel): OpenAICompletionsCompat {
	return source.reasoningOptions?.some((option) => option.type === "effort") ? {} : { supportsReasoningEffort: false };
}
