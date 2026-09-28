/**
 * Relevance-based context pruning for pi, ported from
 * openclaude/src/utils/relevancePruning.ts (scoring + packing) and the
 * pre-compact prune step in openclaude/src/services/compact/autoCompact.ts
 * (trigger + target math), adapted to pi's append-only transcript:
 *
 * - Pruning omits whole entries via context_edit drafts (replacement: null)
 *   instead of rewriting a live message array, so it is durable and
 *   replay-safe and never orphans a tool_use from its tool_result.
 * - Entries carrying tool calls, tool results, or errors are hard-protected
 *   (CC only boosts their score, but pi entries split assistant tool_use and
 *   tool_result into separate entries — dropping one side would orphan the
 *   pair). Same for compaction entries: they carry the previous summary.
 * - The keyword-overlap term is dropped: pi has no CC-style taskContext.
 *
 * Env: PI_PRUNE_TAIL_TURNS — recent turns preserved verbatim (default 3).
 *      Same normalization rule as CC's compactTailTurns: a finite value >= 1
 *      floors to an integer, anything else falls back to the default.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { estimateTokens } from "../../../coding-agent/src/core/compaction/compaction.ts";
import type { ProjectedSessionEntry } from "../../../coding-agent/src/core/session-manager.ts";

export const DEFAULT_PRUNE_TAIL_TURNS = 3;
const RECENCY_WINDOW_MS = 60 * 60 * 1000;

export function normalizePruneTailTurns(value: unknown): number {
	// Only numbers (config) and strings (env) are coercible; other shapes fall back.
	const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(num) && num >= 1 ? Math.floor(num) : DEFAULT_PRUNE_TAIL_TURNS;
}

export function getPruneTailTurns(): number {
	return normalizePruneTailTurns(process.env.PI_PRUNE_TAIL_TURNS);
}

function isAssistantWithToolCalls(message: AgentMessage): boolean {
	return (
		message.role === "assistant" && (message as AssistantMessage).content.some((block) => block.type === "toolCall")
	);
}

function hasToolInteraction(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => message.role === "toolResult" || isAssistantWithToolCalls(message));
}

function hasErrors(messages: readonly AgentMessage[]): boolean {
	return messages.some(
		(message) =>
			(message.role === "assistant" && (message as AssistantMessage).stopReason === "error") ||
			(message.role === "toolResult" && message.isError),
	);
}

function newestMessageTimeMs(messages: readonly AgentMessage[]): number {
	let newest = 0;
	for (const message of messages) newest = Math.max(newest, message.timestamp);
	return newest;
}

/**
 * CC calculateRelevance, entry-granular. Only text-only user/assistant entries
 * ever become prune candidates, so the tool/error boosts matter only for
 * scoring fidelity/tests; protection is enforced separately in isPruneCandidate.
 */
export function scoreEntryRelevance(entry: ProjectedSessionEntry, nowMs: number): number {
	let score = 0.5;
	if (hasToolInteraction(entry.messages)) score += 0.25;
	if (hasErrors(entry.messages)) score += 0.3;
	if (nowMs - newestMessageTimeMs(entry.messages) < RECENCY_WINDOW_MS) score += 0.15;
	if (entry.messages.some((message) => message.role === "user")) score += 0.1;
	return Math.min(1, score);
}

/**
 * A prune candidate is a pure text entry: only user/assistant messages with no
 * tool calls and no errors. Everything else (system, tool interactions, errors,
 * compaction summaries, custom entries) is hard-protected.
 */
function isPruneCandidate(entry: ProjectedSessionEntry): boolean {
	if (entry.messages.length === 0) return false;
	if (hasToolInteraction(entry.messages)) return false;
	if (hasErrors(entry.messages)) return false;
	return entry.messages.every((message) => message.role === "user" || message.role === "assistant");
}

function entryTokenEstimate(entry: ProjectedSessionEntry): number {
	let tokens = 0;
	for (const message of entry.messages) tokens += estimateTokens(message);
	return tokens;
}

/**
 * Select projected entries to omit, lowest relevance first, until the
 * projection drops to targetTokens (or candidates run out).
 *
 * Protected from pruning:
 * - the most recent tailTurns turns (walked back from the end by user-message
 *   turn starts, mirroring CC's preserveRecent slice),
 * - compaction entries (they carry the previous summary),
 * - anything that is not a pure text entry (tools/errors/system/custom).
 *
 * Tie-break matches CC's keep-sort (score desc, then time desc): among equal
 * scores the older entry is dropped first.
 */
export function selectPruneTargets(
	entries: readonly ProjectedSessionEntry[],
	projectedTokens: number,
	targetTokens: number,
	tailTurns: number,
	nowMs: number,
): string[] {
	if (projectedTokens <= targetTokens) return [];

	// Walk back tailTurns turn starts from the end; everything from the last
	// one onward is protected. Fewer turn starts than tailTurns protects all.
	let tailStart = 0;
	let turns = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].messages.some((message) => message.role === "user")) {
			turns++;
			if (turns >= tailTurns) {
				tailStart = i;
				break;
			}
		}
	}

	const candidates: { id: string; score: number; timeMs: number; tokens: number }[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (i >= tailStart) continue;
		const entry = entries[i];
		if (entry.sourceEntry.type === "compaction") continue;
		if (!isPruneCandidate(entry)) continue;
		candidates.push({
			id: entry.sourceEntry.id,
			score: scoreEntryRelevance(entry, nowMs),
			timeMs: newestMessageTimeMs(entry.messages),
			tokens: entryTokenEstimate(entry),
		});
	}

	candidates.sort((a, b) => a.score - b.score || a.timeMs - b.timeMs);

	const targets: string[] = [];
	let omittedTokens = 0;
	for (const candidate of candidates) {
		if (projectedTokens - omittedTokens <= targetTokens) break;
		targets.push(candidate.id);
		omittedTokens += candidate.tokens;
	}
	return targets;
}
