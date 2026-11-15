// Google Gemini and Gemma models.

import type { ThinkingLevelMap } from "../../src/types.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";
import type { ModelsDevReasoningOption } from "../sources/models-dev.ts";

// Smaller working context used for Pi's compaction, not the advertised API maximum. Live replays on
// 2026-11-15 failed at 332,078 tokens; one 98,353-token suffix succeeded with HIGH and the full toolset.
export const GOOGLE_COMPACTION_CONTEXT_WINDOWS: Record<string, number> = {
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
