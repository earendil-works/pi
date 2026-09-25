/**
 * Claude Code-style compaction for pi, ported from
 * free-code/src/services/compact/compact.ts and autoCompact.ts.
 *
 * Differences from pi's built-in compaction (documented adaptations):
 * - Single full-conversation summary with the 9-section CC prompt; no cut-point,
 *   no split-turn merge, no incremental update prompt.
 * - Prompt-too-long retries drop oldest turn groups (CC truncateHeadForPTLRetry).
 * - Post-compact re-injection of recently read files happens inside the summary
 *   text (pi replaces everything up to firstKeptEntryId; CC uses attachments).
 * - The 3-failure circuit breaker lives here because agent-session.ts cannot be edited.
 */
import { readFileSync } from "node:fs";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import { contentText, normalizeContext, uuidv7 } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, TranscriptContext, Usage } from "@earendil-works/pi-ai/compat";
import {
	type CompactionDetails,
	type CompactionPreparation,
	type CompactionResult,
	completeSummarization,
} from "../../../coding-agent/src/core/compaction/compaction.ts";
import {
	computeFileLists,
	formatFileOperations,
	serializeConversation,
} from "../../../coding-agent/src/core/compaction/utils.ts";
import { convertToLlm } from "../../../coding-agent/src/core/messages.ts";
import { isCompactDisabled, recordAutoCompactFailure, recordAutoCompactSuccess } from "../context/detection.ts";
import { formatCompactSummary, getCompactPrompt } from "./prompt.ts";

const MAX_PTL_RETRIES = 3;
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;
const POST_COMPACT_TOKEN_BUDGET = 50_000;
const TOKENS_PER_FILE_CAP = 5_000;
const CHARS_PER_TOKEN = 4;

const OVERFLOW_ERROR_PATTERN =
	/prompt is too long|prompt too long|context (window )?(too long|length)|maximum context|input is too long|reduce the (length|input)/i;

function isPromptTooLongError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return OVERFLOW_ERROR_PATTERN.test(message);
}

/** Drop the oldest user+assistant round so the retry prompt fits (CC truncateHeadForPTLRetry). */
function dropOldestTurn(messages: AgentMessage[]): AgentMessage[] {
	const next = [...messages];
	// Drop the leading user message and everything up to and including the first assistant reply.
	while (next.length > 0 && next[0].role !== "assistant") {
		next.shift();
	}
	if (next.length > 0) {
		next.shift();
	}
	return next;
}

/** Build the provider context for a standalone summary request. */
function buildSummarizationContext(promptText: string): TranscriptContext {
	return normalizeContext({
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	});
}

function createSummaryOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	sessionId: string | undefined,
) {
	const options = { maxTokens, signal, apiKey, headers, env, sessionId } as Parameters<
		typeof completeSummarization
	>[2];
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/**
 * CC-style summary of an error-free response check, matching pi's getSummarizationFailure semantics.
 */
function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	return undefined;
}

/**
 * Generate a Claude Code-style conversation summary and return its provider usage.
 * Overrides pi's generateSummaryWithUsage; used by compact() below and exported so the
 * wrapper module can replace the upstream export.
 */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
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

	const instructions = [
		customInstructions,
		previousSummary
			? "A summary of the earlier conversation is provided in <previous-summary> tags. Merge it into your new summary: preserve all information it contains that is still relevant, and structure the result with the 9 sections described above."
			: undefined,
	].filter((part): part is string => part !== undefined);
	promptText += getCompactPrompt(instructions.join("\n\n"));

	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText),
		createSummaryOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId),
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Summarization attempted to call a tool");
	}

	return { text: formatCompactSummary(contentText(response.content)), usage: response.usage };
}

/** CC-style generateSummary; overrides the upstream export. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		)
	).text;
}

/**
 * Re-inject the most recently read files into the summary text, matching CC's
 * post-compact attachments (POST_COMPACT_MAX_FILES_TO_RESTORE=5, 50k token budget, ~5k/file).
 */
function buildRecentFilesSection(readFiles: string[]): string {
	if (readFiles.length === 0) return "";

	const recentFiles = readFiles.slice(-POST_COMPACT_MAX_FILES_TO_RESTORE);
	let totalChars = 0;
	const maxTotalChars = POST_COMPACT_TOKEN_BUDGET * CHARS_PER_TOKEN;
	const sections: string[] = [];

	for (const file of recentFiles) {
		const remaining = maxTotalChars - totalChars;
		const perFileCap = Math.min(TOKENS_PER_FILE_CAP * CHARS_PER_TOKEN, remaining);
		if (perFileCap <= 0) break;
		try {
			const content = readFileSync(file, "utf8");
			const excerpt = content.length > perFileCap ? `${content.slice(0, perFileCap)}\n… [truncated]` : content;
			totalChars += excerpt.length;
			sections.push(`### \`${file}\`\n\n\`\`\`\n${excerpt}\n\`\`\``);
		} catch {
			// Unreadable file (deleted, permission, binary): skip, matching CC's tolerant restore.
		}
	}

	if (sections.length === 0) return "";
	return `\n\n## Recently Read Files (post-compact context)\n\n${sections.join("\n\n")}`;
}

/**
 * Claude Code-style compaction: one full-conversation summary, PTL retry, circuit breaker,
 * file re-injection. Signature-compatible with pi's compact(); overrides the upstream export.
 *
 * firstKeptEntryId stays pi's cut point (the recent tail must survive for session-tree
 * structure); the summary itself always covers the whole conversation since the last
 * compaction boundary.
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<CompactionResult> {
	if (isCompactDisabled()) {
		throw new Error("Compaction is disabled (PI_DISABLE_COMPACT is set)");
	}

	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
	if (allMessages.length === 0) {
		throw new Error("Nothing to compact");
	}

	let messages = allMessages;
	let result: { text: string; usage: Usage };
	for (let attempt = 0; ; attempt++) {
		try {
			result = await generateSummaryWithUsage(
				messages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				streamFn,
				env,
				retry,
				callbacks,
				sessionId ?? uuidv7(),
			);
			break;
		} catch (error) {
			if (isPromptTooLongError(error) && messages.length > 1 && attempt < MAX_PTL_RETRIES) {
				messages = dropOldestTurn(messages);
				continue;
			}
			recordAutoCompactFailure();
			throw error;
		}
	}
	recordAutoCompactSuccess();

	let summary = result.text;

	// Keep pi's file-ops trailer convention (the TUI and details field rely on it)…
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	// …then CC-style re-injection of recent file contents inside the summary text.
	summary += buildRecentFilesSection(readFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: result.usage,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}
