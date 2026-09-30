/**
 * getContextUsage() override for the AgentSession wrapper.
 *
 * Upstream returns { tokens: null } right after a compaction, so the footer shows
 * "?" until the next LLM response. The compacted transcript is still estimable —
 * folded system prompt + compaction summary + recent messages — so we return a
 * heuristic estimate instead. The post-compaction usage path is unchanged.
 *
 * The percent base follows detection.getContextPercentBaseWindow(): when a
 * persisted context-window cap shrinks the model's advertised window, fullness
 * is reported against the effective threshold window (e.g. a capped 1M-context
 * model shows N%/242K), so the meter grows at the pace auto-compact actually
 * fires at instead of crawling against an unreachable denominator.
 */

import type { AgentSession } from "../../../coding-agent/src/core/agent-session.ts";
import type { ContextUsage } from "../../../coding-agent/src/core/extensions/types.ts";
import { getLatestCompactionEntry } from "../../../coding-agent/src/core/session-manager.ts";
import { getContextPercentBaseWindow } from "./detection.ts";
import { calculateContextTokensPlus, estimateContextTokensPlus } from "./estimate.ts";

export function getContextUsagePlus(session: AgentSession): ContextUsage | undefined {
	const model = session.model;
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;
	const percentBase = getContextPercentBaseWindow(model);

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// We can only trust usage from an assistant that responded after the latest compaction.
	const branchEntries = session.sessionManager.getBranch();
	const latestCompaction = getLatestCompactionEntry(branchEntries);

	if (latestCompaction) {
		const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
		let hasPostCompactionUsage = false;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const assistant = entry.message;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
					if (calculateContextTokensPlus(assistant.usage) > 0) {
						hasPostCompactionUsage = true;
						break;
					}
				}
			}
		}

		if (!hasPostCompactionUsage) {
			// Upstream gives up here ({ tokens: null, percent: null }). Estimate instead:
			// the compacted transcript is small and fully heuristic-countable.
			const estimate = estimateContextTokensPlus(session.messages);
			return {
				tokens: estimate.tokens,
				contextWindow: percentBase,
				percent: (estimate.tokens / percentBase) * 100,
			};
		}
	}

	const estimate = estimateContextTokensPlus(session.messages);
	return {
		tokens: estimate.tokens,
		contextWindow: percentBase,
		percent: (estimate.tokens / percentBase) * 100,
	};
}
