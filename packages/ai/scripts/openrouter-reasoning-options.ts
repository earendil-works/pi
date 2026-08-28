import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";
import { getEffortThinkingLevelMap } from "./models-dev-reasoning-options.ts";

export interface OpenRouterReasoningMetadata {
	mandatory?: boolean;
	default_enabled?: boolean;
	supported_efforts?: Array<ThinkingLevel | "none">;
	default_effort?: ThinkingLevel | "none";
}

/** Convert OpenRouter's reasoning metadata into Pi model capabilities. */
export function getOpenRouterThinkingLevelMap(
	reasoning: OpenRouterReasoningMetadata | undefined,
): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	if (!reasoning.supported_efforts?.length) return reasoning.mandatory === true ? { off: null } : undefined;

	// OpenRouter's supported_efforts uses the same effort values as models.dev reasoning_options,
	// so both sources can share the same Pi thinking-level conversion.
	const map = getEffortThinkingLevelMap([{ type: "effort", values: reasoning.supported_efforts }]);
	if (!map) return reasoning.mandatory === true ? { off: null } : undefined;
	return { ...map, off: reasoning.mandatory === true ? null : "none" };
}
