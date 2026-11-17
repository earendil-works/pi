// Google Gemini and Gemma models.

import type { ThinkingLevelMap } from "../../src/types.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import type { ModelsDevReasoningOption } from "../sources/models-dev.ts";

// Gemini 4 models decode at most 65,536 output tokens per request and emit finishReason CONTINUATION
// above that cap. Default to a two-hop (131,072-token) whole-turn budget across Google and Vertex.
export const GOOGLE_LONG_DECODE_MAX_TOKENS: Record<string, number> = {
	"gemini-4-argon": 131072,
	"gemini-4-carbon": 131072,
	"gemini-4-hydrogen": 131072,
};

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

/** Gemini effort levels from models.dev, with a Gemma 4 fallback. */
export function googleThinkingLevels(
	modelId: string,
	reasoningOptions: readonly ModelsDevReasoningOption[] = [],
): ThinkingLevelMap | undefined {
	const effortMap = getEffortThinkingLevelMap(reasoningOptions);
	if (effortMap) return effortMap;
	if (isGemma4Model(modelId)) {
		return { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" };
	}
	return undefined;
}
