/**
 * Whole-request context estimation for pi.
 *
 * Upstream's estimateTokens() has no case for system messages, so every heuristic
 * estimate (before the first response, after compaction, zero-usage messages,
 * mid-session prompt/tool changes) misses the system prompt and tool definitions
 * entirely — tens of thousands of tokens with skills enabled. This module counts
 * them by folding the transcript's system messages into the effective prompt/tools
 * before estimating, and hardens the usage anchor:
 * - prefix guard: a usage block is only trusted if no message with a newer
 *   timestamp sits in the prefix before it (ported from pi-ai's estimate.ts, which
 *   upstream's coding-agent copy lacks);
 * - cacheWrite1h: Anthropic reports 1h cache writes in a bucket disjoint from
 *   cacheWrite and excludes them from its totalTokens; Bedrock reports them as a
 *   subset of cacheWrite (already included). Only add when they exceed the 5m
 *   bucket, which distinguishes the two.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import type { AssistantMessage, SystemMessage, Usage } from "@earendil-works/pi-ai/compat";
import { getCurrentSystemMessage } from "../../../ai/src/utils/transcript.ts";
import { type ContextUsageEstimate, estimateTokens } from "../../../coding-agent/src/core/compaction/compaction.ts";

const CHARS_PER_TOKEN = 4;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/**
 * Total context tokens for a usage block. Prefers the provider-reported total and
 * adds 1h cache writes when the provider reports them outside the 5m cacheWrite
 * bucket (Anthropic). Falls back to summing components when totalTokens is missing.
 */
export function calculateContextTokensPlus(usage: Usage): number {
	if (usage.totalTokens) {
		const extra1h = usage.cacheWrite1h && usage.cacheWrite1h > usage.cacheWrite ? usage.cacheWrite1h : 0;
		return usage.totalTokens + extra1h;
	}
	return usage.input + usage.output + usage.cacheRead + Math.max(usage.cacheWrite, usage.cacheWrite1h ?? 0);
}

/**
 * Estimated tokens for one (already folded) system message: rendered prompt text
 * (content + sections) plus the JSON of tool declarations added/removed.
 */
export function estimateSystemMessageTokens(system: SystemMessage): number {
	let chars = getSystemMessageText(system).length;
	if (system.toolsAdded && system.toolsAdded.length > 0) chars += safeJsonStringify(system.toolsAdded).length;
	if (system.toolsRemoved && system.toolsRemoved.length > 0) chars += safeJsonStringify(system.toolsRemoved).length;
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function isSystemMessage(message: AgentMessage): message is SystemMessage {
	return message.role === "system";
}

/**
 * Estimated tokens of the effective system prompt + tool declarations, obtained by
 * replaying the transcript's system messages (later `content` appends to the base
 * prompt, `sections` patch by name, tools accumulate with removals) instead of
 * summing per-message — a plain sum would count patched sections multiple times.
 */
export function estimateEffectiveSystemTokens(messages: readonly AgentMessage[]): number {
	const folded = getCurrentSystemMessage(messages);
	return folded ? estimateSystemMessageTokens(folded) : 0;
}

/**
 * Most recent assistant usage that still describes the current transcript prefix.
 * Unlike upstream's plain reverse scan, a usage block is rejected when a message
 * with a newer timestamp precedes it (e.g. a compaction summary inserted into the
 * middle of the transcript), since that usage can no longer describe the prefix.
 */
function getLastAssistantUsageInfo(messages: readonly AgentMessage[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				assistant.usage &&
				calculateContextTokensPlus(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

/**
 * Estimate context tokens for the whole request, not just the conversation.
 *
 * Non-system messages keep upstream's anchor+trailing treatment (last real usage
 * plus chars/4 for messages after it). System tokens are added from the folded
 * effective state: always on the no-anchor fallback path, and on the anchor path
 * only when a system message appears after the anchor (prompt/tools changed
 * mid-session, so the anchor no longer reflects current system state). The latter
 * can slightly overcount — the anchor still carries the old system prompt — but
 * only in that rare case, where upstream undercounts by the entire system size.
 */
export function estimateContextTokensPlus(messages: readonly AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let nonSystemTokens = 0;
		for (const message of messages) {
			if (isSystemMessage(message)) continue;
			nonSystemTokens += estimateTokens(message);
		}
		const tokens = nonSystemTokens + estimateEffectiveSystemTokens(messages);
		return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
	}

	let trailingTokens = 0;
	let systemChangedAfterAnchor = false;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		if (isSystemMessage(messages[i])) {
			systemChangedAfterAnchor = true;
			continue;
		}
		trailingTokens += estimateTokens(messages[i]);
	}

	const usageTokens = calculateContextTokensPlus(usageInfo.usage);
	let tokens = usageTokens + trailingTokens;
	if (systemChangedAfterAnchor) {
		tokens += estimateEffectiveSystemTokens(messages);
	}

	return { tokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
}
