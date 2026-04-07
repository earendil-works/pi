import type { Api, Message, Model, OnContextOverflowParams, OnContextOverflowResult } from "@kennyfrc/mu-ai";

import { executeExplicitCompactionStrategy } from "./morph-compaction-explicit.js";
import type { HandoffDetails } from "./tools/handoff.js";

export interface ContextOverflowRecoveryOptions {
	model: Model<Api>;
	signal?: AbortSignal;
	morphApiKey?: string | null;
	keyFiles?: string[];
	/** For testing: custom fetch implementation */
	fetchImpl?: typeof fetch;
}

/**
 * Handles context overflow by removing the oversized tool result and compacting the remaining messages.
 *
 * @param params - Overflow parameters including messages and the last tool result that caused overflow
 * @param options - Recovery options including model and optional abort signal
 * @returns Result indicating whether to retry with compacted messages
 */
export async function handleContextOverflow(
	params: OnContextOverflowParams,
	options: ContextOverflowRecoveryOptions,
): Promise<OnContextOverflowResult> {
	// 1. Remove the last tool result from messages
	const messagesWithoutLastToolResult = params.messages.filter((m) => m !== params.lastToolResult);

	// 2. Derive goal from recent messages
	const goal = deriveGoalFromMessages(messagesWithoutLastToolResult);

	// 3. Execute Morph compaction
	const result = await executeExplicitCompactionStrategy({
		messages: messagesWithoutLastToolResult,
		goal,
		model: options.model,
		morphApiKey: options.morphApiKey,
		keyFiles: options.keyFiles ?? [],
		signal: options.signal,
		fetchImpl: options.fetchImpl,
		localSummaryFallback: async () => buildEmptyHandoffDetails(goal),
		nativeReplayCompact: async () => ({
			details: buildEmptyHandoffDetails(goal),
			usedFallback: true,
			fallbackReason: "Native replay not available for overflow recovery",
		}),
	});

	if (result.details.replacementMessages && result.details.replacementMessages.length > 0) {
		return {
			shouldRetry: true,
			compactedMessages: result.details.replacementMessages,
		};
	}

	return {
		shouldRetry: false,
		compactedMessages: [],
	};
}

/**
 * Derives a goal from the last user message in the conversation.
 * Truncates to a maximum of 12 words for use as a compaction query.
 */
function deriveGoalFromMessages(messages: Message[]): string {
	// Extract goal from last user message
	const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
	if (!lastUserMessage) return "Continue the task";

	const text = extractTextFromContent(lastUserMessage.content);
	if (!text) return "Continue the task";

	// Truncate to reasonable goal length (12 words)
	const words = text.split(/\s+/).slice(0, 12);
	return words.join(" ");
}

/**
 * Extracts text content from a message content block (string or array of content blocks).
 */
function extractTextFromContent(content: string | unknown[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const textBlocks: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const rec = block as Record<string, unknown>;
		if (rec.type === "text" && typeof rec.text === "string") {
			textBlocks.push(rec.text);
		}
	}
	return textBlocks.join(" ");
}

/**
 * Builds an empty HandoffDetails fallback for cases where compaction cannot proceed.
 */
function buildEmptyHandoffDetails(goal: string): HandoffDetails {
	return {
		handoffType: "explicit",
		goal,
		formattedMessage: `## Goal\n${goal}`,
		parentSessionId: "",
		fileTokens: 0,
		replacementMessages: [],
		keyFiles: [],
	};
}
