/**
 * pi-plus-context-guard: openclaude-inspired context defense layers that pi's
 * extension API can express without touching upstream:
 *
 * - turn_end, message-count force trigger (CC's 'message-count' reason): when the
 *   projected active message count exceeds PI_MAX_ACTIVE_MESSAGES (default 1000),
 *   force compaction regardless of the token threshold. Bypasses
 *   PI_DISABLE_AUTO_COMPACT, matching CC; PI_DISABLE_COMPACT still wins.
 * - turn_end, relevance pruning (CC's pre-compact prune in autoCompact.ts): when
 *   the projected request reaches the auto-compact threshold, omit low-relevance
 *   old text entries via context_edit drafts, so the next request — and any
 *   compaction it triggers — works on a smaller projection (see
 *   plus/src/context/pruning.ts).
 * - session_start, resume compact suggestion (CC's resumeCompactPrompt.ts): offer
 *   to compact immediately when a resumed session is already >= 70% of the
 *   auto-compact threshold. TUI-only, like CC's interactive-only prompt.
 *
 * Time-based micro-compact lives separately in the AgentSession subclass
 * constructor (see plus/src/context/microcompact.ts).
 */

import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import {
	getAutoCompactThreshold,
	getCurrentModel,
	isAutoCompactBreakerTripped,
	isAutoCompactDisabled,
	isCompactDisabled,
} from "../../context/detection.ts";
import { estimateContextTokensPlus } from "../../context/estimate.ts";
import { getPruneTailTurns, selectPruneTargets } from "../../context/pruning.ts";

const DEFAULT_MAX_ACTIVE_MESSAGES = 1000;
const RESUME_COMPACT_THRESHOLD_FRACTION = 0.7;
const RESUME_PROMPT_TIMEOUT_MS = 30_000;

/**
 * Hard cap on projected active (non-system) messages, CC's
 * DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP. Undefined disables the trigger
 * (PI_MAX_ACTIVE_MESSAGES=0 or unparseable).
 */
function getMaxActiveMessagesLimit(): number | undefined {
	const raw = process.env.PI_MAX_ACTIVE_MESSAGES;
	if (raw === undefined || raw === "") return DEFAULT_MAX_ACTIVE_MESSAGES;
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/** True when the session has prior content: explicit resume/fork, or CLI -r/-c
 *  (reported as "startup"; non-empty branch is the sdk.ts heuristic). */
function isResumedSession(reason: string, hasEntries: boolean): boolean {
	return reason === "resume" || reason === "fork" || (reason === "startup" && hasEntries);
}

export function registerContextGuard(pi: ExtensionAPI): void {
	pi.on("turn_end", (_event, ctx) => {
		if (isCompactDisabled()) return;

		const projection = ctx.sessionManager.buildSessionProjection();

		// 1. Message-count force trigger.
		const limit = getMaxActiveMessagesLimit();
		if (limit !== undefined) {
			const activeMessages = projection.messages.filter((message) => message.role !== "system").length;
			if (activeMessages > limit) {
				ctx.compact();
				return;
			}
		}

		// 2. Relevance pruning at the auto-compact threshold.
		if (isAutoCompactDisabled() || isAutoCompactBreakerTripped()) return;
		const model = getCurrentModel() ?? ctx.model;
		if (!model) return; // no window math possible; upstream's reserve-based fallback applies
		const threshold = getAutoCompactThreshold(model);
		const { tokens } = estimateContextTokensPlus(projection.messages);
		if (tokens < threshold) return;
		const targets = selectPruneTargets(projection.entries, tokens, threshold, getPruneTailTurns(), Date.now());
		if (targets.length === 0) return;
		return {
			entries: targets.map((targetId) => ({ type: "context_edit" as const, targetId, replacement: null })),
		};
	});

	pi.on("session_start", async (event, ctx) => {
		if (!isResumedSession(event.reason, ctx.sessionManager.getBranch().length > 0)) return;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (isAutoCompactDisabled() || isAutoCompactBreakerTripped()) return;
		const model = getCurrentModel() ?? ctx.model;
		if (!model) return;
		const threshold = getAutoCompactThreshold(model);
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? 0;
		if (tokens < threshold * RESUME_COMPACT_THRESHOLD_FRACTION) return;

		const percent = usage?.percent ?? Math.max(0, Math.round((tokens / model.contextWindow) * 100));
		const yes = await ctx.ui.confirm(`Context is ${percent}% full`, "Compact now before continuing?", {
			timeout: RESUME_PROMPT_TIMEOUT_MS,
		});
		if (yes) {
			// compact() synchronously emits compaction_start, but the TUI only
			// renders it once it has subscribed to session events — and that
			// subscription happens after extension binding, i.e. after this
			// handler returns. Defer to the next macrotask (microtasks — the
			// rest of startup, including the subscription — always drain first)
			// so the "Compacting context..." indicator actually shows.
			setTimeout(() => {
				ctx.compact();
			}, 0);
		}
	});
}
