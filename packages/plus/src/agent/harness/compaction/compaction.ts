/**
 * Wrapper for packages/agent/src/harness/compaction/compaction.ts.
 *
 * Pass-through except:
 * - shouldCompact               -> Claude Code threshold semantics (plus/src/context/detection.ts)
 * - generateSummaryWithRequest  -> Claude Code 9-section prompt + formatCompactSummary output
 * - generateSummary(WithUsage)  -> thin re-dispatchers onto the CC request above (upstream's
 *   versions bind the upstream request function directly, so they must be shadowed too)
 *
 * Note: the CC threshold math needs the model's maxTokens; harness callers that never
 * resolve a model through the coding-agent model-resolver fall back to pi's original math.
 */
export * from "../../../../../agent/src/harness/compaction/compaction.ts";

import {
	type Api,
	type AssistantMessage,
	contentText,
	type Model,
	type Models,
	type RetryCallbacks,
	type RetryPolicy,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	type CompactionSettings,
	completeSimpleWithRetries,
	createSummaryRequestOptions,
	type SummaryGenerationOptions,
	type SummaryRequest,
} from "../../../../../agent/src/harness/compaction/compaction.ts";
import { serializeConversation } from "../../../../../agent/src/harness/compaction/utils.ts";
import type { Context } from "../../../../../agent/src/harness/context.ts";
import { convertToLlm } from "../../../../../agent/src/harness/messages.ts";
import { CompactionError, err, ok, type Result } from "../../../../../agent/src/harness/types.ts";
import type { AgentMessage, ThinkingLevel } from "../../../../../agent/src/types.ts";
import { formatCompactSummary, getCompactPrompt } from "../../../../src/compaction/prompt.ts";
import { shouldCompactWithCcThreshold } from "../../../../src/context/detection.ts";

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	return shouldCompactWithCcThreshold(contextTokens, contextWindow, settings);
}

const PREVIOUS_SUMMARY_MERGE_INSTRUCTION =
	"A summary of the earlier conversation is provided in <previous-summary> tags. " +
	"Merge it into your new summary: preserve all information it contains that is still relevant, " +
	"and structure the result with the 9 sections described above.";

export async function generateSummaryWithRequest(
	currentMessages: AgentMessage[],
	options: SummaryGenerationOptions,
	request: SummaryRequest,
	context: Context,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const { model, reserveTokens, customInstructions, previousSummary, thinkingLevel } = options;
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}

	const instructions = [customInstructions, previousSummary ? PREVIOUS_SUMMARY_MERGE_INSTRUCTION : undefined].filter(
		(part): part is string => part !== undefined,
	);
	promptText += getCompactPrompt(instructions.join("\n\n"));

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, reasoning: thinkingLevel }
			: { maxTokens };

	// CC puts the full compact prompt in the user turn; no separate system prompt.
	const response: AssistantMessage = await request(
		{ messages: summarizationMessages },
		createSummaryRequestOptions(completionOptions, context),
		context,
	);
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	return ok({ text: formatCompactSummary(contentText(response.content)), usage: response.usage });
}

export function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	return generateSummaryWithRequest(
		currentMessages,
		{ model, reserveTokens, customInstructions, previousSummary, thinkingLevel },
		(aiContext, options, requestContext) =>
			completeSimpleWithRetries(models, model, aiContext, options, retry, callbacks, requestContext),
		context,
	);
}

export async function generateSummary(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<Result<string, CompactionError>> {
	const result = await generateSummaryWithUsage(
		currentMessages,
		models,
		model,
		reserveTokens,
		customInstructions,
		previousSummary,
		thinkingLevel,
		retry,
		callbacks,
		context,
	);
	return result.ok ? ok(result.value.text) : err(result.error);
}
