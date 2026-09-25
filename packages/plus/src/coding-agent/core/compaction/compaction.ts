/**
 * Wrapper for packages/coding-agent/src/core/compaction/compaction.ts.
 *
 * Everything passes through to the upstream module except:
 * - shouldCompact   -> Claude Code threshold semantics (see plus/src/context/detection.ts)
 * - compact         -> Claude Code full-conversation summary (see plus/src/compaction/compact.ts)
 * - generateSummary / generateSummaryWithUsage -> CC 9-section prompt + formatting
 * - estimateContextTokens -> whole-request estimate incl. folded system prompt/tools
 *   and a prefix-guarded usage anchor (see plus/src/context/estimate.ts)
 * - calculateContextTokens -> cacheWrite1h-aware usage total
 */
export * from "../../../../../coding-agent/src/core/compaction/compaction.ts";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type {
	CompactionSettings,
	ContextUsageEstimate,
} from "../../../../../coding-agent/src/core/compaction/compaction.ts";
import {
	compact as compactCc,
	generateSummary as generateSummaryCc,
	generateSummaryWithUsage as generateSummaryWithUsageCc,
} from "../../../compaction/compact.ts";
import { shouldCompactWithCcThreshold } from "../../../context/detection.ts";
import { calculateContextTokensPlus, estimateContextTokensPlus } from "../../../context/estimate.ts";

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	return shouldCompactWithCcThreshold(contextTokens, contextWindow, settings);
}

export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	return estimateContextTokensPlus(messages);
}

export function calculateContextTokens(usage: Usage): number {
	return calculateContextTokensPlus(usage);
}

export const compact = compactCc;
export const generateSummary = generateSummaryCc;
export const generateSummaryWithUsage = generateSummaryWithUsageCc;
