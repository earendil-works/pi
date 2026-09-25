/**
 * Wrapper for packages/coding-agent/src/core/defaults.ts.
 *
 * Pass-through except DEFAULT_THINKING_LEVEL, which honors the plus env knobs
 * (PI_DISABLE_THINKING / PI_MAX_THINKING_TOKENS) before falling back to upstream.
 */
export * from "../../../../coding-agent/src/core/defaults.ts";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_THINKING_LEVEL as UPSTREAM_DEFAULT_THINKING_LEVEL } from "../../../../coding-agent/src/core/defaults.ts";
import { resolveDefaultThinkingLevelFromEnv } from "../../reasoning/effort.ts";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel =
	resolveDefaultThinkingLevelFromEnv() ?? UPSTREAM_DEFAULT_THINKING_LEVEL;
