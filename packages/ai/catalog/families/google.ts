// Google Gemini and Gemma models.

import type { ThinkingLevelMap } from "../../src/types.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import type { ModelsDevReasoningOption } from "../sources/models-dev.ts";

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
