/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	normalizeContext,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	uuidv7,
} from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	SystemMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getPromptCacheTtlMs, priceTokens } from "../cache-warmer.ts";
import { convertToLlm } from "../messages.ts";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ProjectedSessionEntry,
	type SessionEntry,
	type SessionProjection,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import { combineUsage } from "../usage-totals.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
	/** Outcome of the in-context attempt. Absent when `compaction.inContext` is off. */
	inContext?: InContextCompactionOutcome;
}

/**
 * What happened to the in-context attempt of one compaction. `skipped` carries the reason the
 * decision chose a standalone summary; `failed` means an attempt was made and Pi fell back.
 * `rebuild` failures happen while reproducing the next-turn request, before anything is sent.
 */
export type InContextCompactionOutcome =
	| { status: "used" }
	| { status: "skipped"; reason: string }
	| { status: "failed"; stage: "rebuild" | "request"; error: string };

/** Read the in-context outcome from compaction details, which extensions may shape freely. */
export function getInContextCompactionOutcome(details: unknown): InContextCompactionOutcome | undefined {
	if (typeof details !== "object" || details === null || !("inContext" in details)) return undefined;
	const outcome = details.inContext;
	if (typeof outcome !== "object" || outcome === null || !("status" in outcome)) return undefined;
	const status = outcome.status;
	return status === "used" || status === "skipped" || status === "failed"
		? (outcome as InContextCompactionOutcome)
		: undefined;
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessagesFromProjectedEntryForCompaction(entry: ProjectedSessionEntry): AgentMessage[] {
	if (entry.sourceEntry.type === "compaction") return [];
	// System messages are prompt state, not conversation; the compaction entry carries their replay.
	return entry.messages.filter((message) => message.role !== "system");
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last valid assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Estimate projected context without trusting usage captured before a later edit or compaction. */
export function estimateProjectedContextTokens(
	projection: SessionProjection,
	branchEntries: SessionEntry[],
): ContextUsageEstimate {
	const estimate = estimateContextTokens(projection.messages);
	if (estimate.lastUsageIndex !== null) {
		let projectedMessageIndex = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const nextMessageIndex = projectedMessageIndex + entry.messages.length;
			if (estimate.lastUsageIndex < nextMessageIndex) {
				usageEntryId = entry.sourceEntry.id;
				break;
			}
			projectedMessageIndex = nextMessageIndex;
		}

		const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
		let latestInvalidatingEntryIndex = -1;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const entry = branchEntries[i];
			if (entry.type === "context_edit" || entry.type === "compaction") {
				latestInvalidatingEntryIndex = i;
				break;
			}
		}
		if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
	}

	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
	for (const message of projection.messages) {
		if (message.role !== "system") tokens += estimateTokens(message);
	}
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "system": {
			const system = message as SystemMessage;
			chars = estimateTextAndImageContentChars(system.content);
			if (system.sections) {
				for (const section of Object.values(system.sections)) {
					if (section) chars += section.length;
				}
			}
			if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
			return Math.ceil(chars / 4);
		}
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

/**
 * Find valid cut points: indices of context-visible user-like or assistant messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "compaction") {
			continue;
		}
		if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the context-visible user-role message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const messageTokens = sessionEntryToContextMessages(entry).reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Prefer the closest valid cut point at or after this entry. If trailing
			// tool results exceed the budget by themselves, keep their preceding
			// assistant tool call instead of falling back to the first message.
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// Scan backwards from cutIndex to include adjacent metadata entries that do not affect context.
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at compaction boundaries or context-visible entries.
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
			break;
		}
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/**
 * Returns an error message when a summarization response cannot safely be persisted.
 * A length stop contains partial text and must not become a session checkpoint.
 */
export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	return undefined;
}

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	sessionId: string | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers, env, sessionId };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/**
 * Shared choke point for every compaction/branch-summary summarization call. Wraps the
 * single LLM call in {@link retryAssistantCall} so transient stream drops (e.g.
 * `terminated`, socket close) honor the configured retry policy instead of failing
 * the whole compaction on the first attempt. Deterministic errors and aborts return
 * immediately (see {@link retryAssistantCall}).
 */
export async function completeSummarization(
	model: Model<any>,
	context: TranscriptContext,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// Avoid cache writes for one-off summaries. Reuse caller-supplied routing when available;
	// callers without a session ID, including branch summaries, receive a fresh routing ID.
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: options.sessionId ?? uuidv7(),
	};
	const produce = async (): Promise<AssistantMessage> =>
		streamFn
			? (await streamFn(model, context, requestOptions)).result()
			: completeSimple(model, context, requestOptions);
	return retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
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

/** Build the provider context for a standalone summary request. */
function buildSummarizationContext(promptText: string): TranscriptContext {
	return normalizeContext({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	});
}

/** Generate or update a conversation summary and return its provider usage. */
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

	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const completionOptions = createSummarizationOptions(
		model,
		maxTokens,
		apiKey,
		headers,
		env,
		signal,
		thinkingLevel,
		sessionId,
	);

	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText),
		completionOptions,
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

	const textContent = contentText(response.content);

	return { text: textContent, usage: response.usage };
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

function isProjectedTurnStart(entry: ProjectedSessionEntry): boolean {
	if (entry.sourceEntry.type === "compaction") return false;
	return entry.messages.some(isTurnStartMessage);
}

function findProjectedTurnStartIndex(entries: ProjectedSessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isProjectedTurnStart(entries[i])) return i;
	}
	return -1;
}

function findProjectedCutPoint(
	entries: ProjectedSessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) cutPoints.push(i);
	}
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	let accumulatedTokens = 0;
	let exceededBudget = false;
	let cutIndex = cutPoints[0];
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const messageTokens = entries[i].messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			exceededBudget = true;
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// A recovery attempt and its omission edits are context-invisible after the last
	// visible input. Advance only for a closed suffix containing an omitted assistant
	// attempt; arbitrary metadata must not move the cut past unsent input.
	const suffix = entries.slice(cutIndex + 1, endIndex);
	const isIntrinsicallyVisible = (entry: ProjectedSessionEntry): boolean =>
		entry.sourceEntry.type !== "context_edit" && sessionEntryToContextMessages(entry.sourceEntry).length > 0;
	const isOmitted = (entry: ProjectedSessionEntry): boolean =>
		isIntrinsicallyVisible(entry) && entry.messages.length === 0;
	const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
	const hasExternalReplacement = suffix.some(
		(entry) =>
			entry.sourceEntry.type === "context_edit" &&
			entry.sourceEntry.replacement !== null &&
			!omittedSuffixIds.has(entry.sourceEntry.targetId),
	);
	const isRecoveryOmissionSuffix =
		exceededBudget &&
		!hasExternalReplacement &&
		suffix.some(
			(entry) =>
				entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant" && isOmitted(entry),
		) &&
		suffix.every(
			(entry) => entry.sourceEntry.type !== "compaction" && (!isIntrinsicallyVisible(entry) || isOmitted(entry)),
		);
	if (isRecoveryOmissionSuffix) cutIndex++;

	while (cutIndex > startIndex) {
		const previous = entries[cutIndex - 1];
		if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0) break;
		cutIndex--;
	}
	const startsTurn = isProjectedTurnStart(entries[cutIndex]);
	const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	const projection = buildSessionProjection(pathEntries);
	const projectedEntries = projection.entries;
	const sourceEntries = projectedEntries.map((entry) => entry.sourceEntry);
	// The newest compaction is projected first. Older compaction entries can still
	// occur in its retained raw range, but their projected contribution is empty.
	const prevCompactionIndex = projectedEntries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		previousSummary = (projectedEntries[prevCompactionIndex].sourceEntry as CompactionEntry).summary;
		// The canonical projection has already selected the previous compaction's retained tail.
		boundaryStart = prevCompactionIndex + 1;
	}
	const boundaryEnd = projectedEntries.length;
	const tokensBefore = estimateProjectedContextTokens(projection, pathEntries).tokens;
	const cutPoint = findProjectedCutPoint(projectedEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
	if (!firstKeptEntry?.id) return undefined;
	const firstKeptEntryId = firstKeptEntry.id;
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	const messagesToSummarize = projectedEntries
		.slice(boundaryStart, historyEnd)
		.flatMap(getMessagesFromProjectedEntryForCompaction);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? projectedEntries
				.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
				.flatMap(getMessagesFromProjectedEntryForCompaction)
		: [];

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	// Extract file operations from edited model-visible messages and the previous compaction.
	const fileOps = extractFileOperations(messagesToSummarize, sourceEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 * @param sessionId - Optional routing session ID forwarded without enabling prompt caching
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
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// Generate summaries and merge into one
	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = previousSummary ?? "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
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
				sessionId,
			);
			historyText = historyResult.text;
			historyUsage = historyResult.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			streamFn,
			retry,
			callbacks,
			sessionId,
		);
		// Merge into single summary
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
		summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
	} else {
		// Just generate history summary
		const result = await generateSummaryWithUsage(
			messagesToSummarize,
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
			sessionId,
		);
		summary = result.text;
		summaryUsage = result.usage;
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	env?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // Smaller budget for turn prefix
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `# Conversation\n${conversationText}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText),
		createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId),
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Turn prefix summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Turn prefix summarization attempted to call a tool");
	}

	return {
		text: contentText(response.content),
		usage: response.usage,
	};
}

// ============================================================================
// In-context compaction
// ============================================================================

/**
 * Instructions appended as a system message to the live conversation. The model sees the
 * whole conversation, including the recent messages that compaction keeps verbatim, so the
 * summary describes the current state instead of the state at the cut point.
 */
export const IN_CONTEXT_COMPACTION_INSTRUCTIONS = `# Context compaction

The conversation is about to be compacted. Everything above will be replaced by a checkpoint summary that you write now. The most recent messages will be kept verbatim after the summary, but the summary must stand on its own for everything earlier.

Do NOT continue the task. Do NOT call tools. Do NOT answer questions from the conversation. Respond only with the summary.

The system prompt and project instructions stay in place after compaction. Do not restate them; record only constraints and preferences that come from the conversation.

If the conversation contains an earlier compaction summary, merge it: preserve its information, move finished items to Done, and update Next Steps.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** User message that asks for the in-context summary after the instructions. */
export const IN_CONTEXT_COMPACTION_PROMPT = "Write the context checkpoint summary now.";

/** Fallback lifetime for models without catalog cache lifetimes: the shortest documented provider lifetime. */
const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60_000;
/** Share of the cache lifetime after which the entry counts as expired. Requests are timed from their start. */
const PROMPT_CACHE_TTL_SAFETY = 0.9;
/** Cost of a cached prompt token relative to an uncached one when the model has no prices. */
const UNPRICED_CACHE_READ_WEIGHT = 0.1;

/**
 * Append the compaction request to the provider transcript of the live conversation.
 * The system message carries the instructions; models that accept system messages
 * mid-conversation receive it in place, so the conversation prefix stays cached.
 */
export function appendInContextCompactionRequest(messages: Message[], customInstructions?: string): Message[] {
	const timestamp = Date.now();
	const prompt = customInstructions
		? `${IN_CONTEXT_COMPACTION_PROMPT}\n\nAdditional focus: ${customInstructions}`
		: IN_CONTEXT_COMPACTION_PROMPT;
	return [
		...messages,
		{ role: "system", content: IN_CONTEXT_COMPACTION_INSTRUCTIONS, timestamp },
		{ role: "user", content: [{ type: "text", text: prompt }], timestamp },
	];
}

/** Whether the model catalog marks the model as keeping its prompt cache for in-context compaction. */
export function supportsInContextCompaction(model: Model<Api>): boolean {
	const compat = model.compat as
		| { supportsMidConvoSystemMessages?: boolean; supportsInContextCompaction?: boolean }
		| undefined;
	return compat?.supportsMidConvoSystemMessages === true && compat.supportsInContextCompaction === true;
}

/** Estimated cost of both summary strategies, excluding output, which is similar for both. */
export interface InContextCompactionCosts {
	/** Prompt tokens of the last response, expected to be read from the cache. */
	cachedTokens: number;
	/** Prompt tokens added since the last response, including the compaction request. */
	uncachedTokens: number;
	/** Estimated prompt tokens of the standalone summary request(s). */
	standaloneTokens: number;
	/** In dollars when `priced`, otherwise in uncached-token equivalents. */
	inContextCost: number;
	standaloneCost: number;
	priced: boolean;
}

export type InContextCompactionDecision = ({ use: true } & InContextCompactionCosts) | { use: false; reason: string };

export interface InContextCompactionInput {
	/** The model that would answer the next turn. */
	model: Model<Api>;
	projection: SessionProjection;
	branchEntries: SessionEntry[];
	preparation: CompactionPreparation;
	/** The session's current thinking level, which the next turn would send. */
	thinkingLevel: ThinkingLevel;
	env?: Record<string, string>;
	now?: number;
}

function serializedTokens(messages: AgentMessage[]): number {
	return Math.ceil(serializeConversation(convertToLlm(messages)).length / 4);
}

/** Estimate the prompt tokens of the standalone requests `compact()` would send. */
function estimateStandaloneSummaryTokens(preparation: CompactionPreparation): number {
	const { messagesToSummarize, turnPrefixMessages, isSplitTurn, previousSummary } = preparation;
	const splitTurn = isSplitTurn && turnPrefixMessages.length > 0;
	let tokens = 0;
	if (!splitTurn || messagesToSummarize.length > 0) {
		const prompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
		const chars = SUMMARIZATION_SYSTEM_PROMPT.length + prompt.length + (previousSummary?.length ?? 0);
		tokens += Math.ceil(chars / 4) + serializedTokens(messagesToSummarize);
	}
	if (splitTurn) {
		const chars = SUMMARIZATION_SYSTEM_PROMPT.length + TURN_PREFIX_SUMMARIZATION_PROMPT.length;
		tokens += Math.ceil(chars / 4) + serializedTokens(turnPrefixMessages);
	}
	return tokens;
}

/**
 * Decide whether to summarize inside the live conversation instead of in a standalone request.
 *
 * In-context compaction repeats the request the next turn would send and appends the
 * compaction instructions. It is only cheaper while the provider still caches that
 * request's prefix, so the decision requires recent cache activity from the same model
 * and thinking level, and compares the estimated prompt cost of both strategies.
 */
export function evaluateInContextCompaction(input: InContextCompactionInput): InContextCompactionDecision {
	const { model, projection, branchEntries, preparation, thinkingLevel } = input;
	const now = input.now ?? Date.now();
	if (!supportsInContextCompaction(model)) {
		return { use: false, reason: "model is not verified for in-context compaction" };
	}

	const estimate = estimateProjectedContextTokens(projection, branchEntries);
	const usageMessage = estimate.lastUsageIndex === null ? undefined : projection.messages[estimate.lastUsageIndex];
	if (!usageMessage || usageMessage.role !== "assistant") {
		return { use: false, reason: "no provider usage for the current context" };
	}
	if (usageMessage.provider !== model.provider || usageMessage.model !== model.id) {
		return { use: false, reason: "last response came from a different model" };
	}
	if (usageMessage.thinkingLevel !== undefined && usageMessage.thinkingLevel !== thinkingLevel) {
		return { use: false, reason: "thinking level changed since the last response" };
	}
	const usage = usageMessage.usage;
	if (usage.cacheRead + usage.cacheWrite === 0) {
		return { use: false, reason: "last response reported no prompt caching" };
	}

	// Cache warming re-sends the request and refreshes the entry.
	let refreshedAt = usageMessage.timestamp;
	for (const entry of branchEntries) {
		if (entry.type !== "usage" || entry.kind !== "cache_warm" || entry.provider !== model.provider) continue;
		refreshedAt = Math.max(refreshedAt, new Date(entry.timestamp).getTime());
	}
	const ttlMs = getPromptCacheTtlMs(model, { env: input.env }) ?? DEFAULT_PROMPT_CACHE_TTL_MS;
	if (now - refreshedAt > ttlMs * PROMPT_CACHE_TTL_SAFETY) {
		return { use: false, reason: "prompt cache has likely expired" };
	}

	const requestTokens = Math.ceil(
		(IN_CONTEXT_COMPACTION_INSTRUCTIONS.length + IN_CONTEXT_COMPACTION_PROMPT.length) / 4,
	);
	const promptTokens = estimate.tokens + requestTokens;
	const outputBudget = Math.floor(0.8 * preparation.settings.reserveTokens);
	if (promptTokens + outputBudget > model.contextWindow) {
		return { use: false, reason: "context is too full for an in-context summary" };
	}

	const cachedTokens = Math.min(usage.input + usage.cacheRead + usage.cacheWrite, promptTokens);
	const uncachedTokens = promptTokens - cachedTokens;
	const standaloneTokens = estimateStandaloneSummaryTokens(preparation);
	const priced = model.cost.input > 0 && model.cost.cacheRead > 0;
	const inContextCost = priced
		? priceTokens(model, {
				cacheRead: cachedTokens,
				...(model.cost.cacheWrite > 0 ? { cacheWrite: uncachedTokens } : { input: uncachedTokens }),
			})
		: cachedTokens * UNPRICED_CACHE_READ_WEIGHT + uncachedTokens;
	const standaloneCost = priced ? priceTokens(model, { input: standaloneTokens }) : standaloneTokens;
	const costs = { cachedTokens, uncachedTokens, standaloneTokens, inContextCost, standaloneCost, priced };
	if (inContextCost >= standaloneCost) {
		return { use: false, reason: "standalone summary is cheaper" };
	}
	return { use: true, ...costs };
}

/** A rejected in-context response. Carries the billed usage so callers can account for it. */
export class InContextCompactionError extends Error {
	readonly usage: Usage;

	constructor(message: string, usage: Usage) {
		super(message);
		this.name = "InContextCompactionError";
		this.usage = usage;
	}
}

/**
 * Generate the compaction summary inside the live conversation.
 *
 * `messages` and `options` must reproduce the request the next turn would send, so the
 * provider reads the cached prefix. Tools stay declared to keep that prefix intact;
 * `toolChoice: "none"` stops the model from calling them. The kept tail is unchanged,
 * so the result has the same shape as `compact()`.
 *
 * @throws {InContextCompactionError} When the response fails, is truncated, calls a tool, or has no
 * text. The response is discarded; callers fall back to `compact()`.
 */
export async function compactInContext(
	preparation: CompactionPreparation,
	model: Model<Api>,
	messages: Message[],
	options: SimpleStreamOptions,
	streamFn: StreamFn,
	customInstructions?: string,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<CompactionResult> {
	const context = normalizeContext({ messages: appendInContextCompactionRequest(messages, customInstructions) });
	const requestOptions: SimpleStreamOptions = { ...options, toolChoice: "none" };
	const response = await retryAssistantCall(
		async () => (await streamFn(model, context, requestOptions)).result(),
		retry,
		requestOptions.signal,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "In-context summarization");
	if (failure) throw new InContextCompactionError(failure, response.usage);
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new InContextCompactionError("In-context summarization attempted to call a tool", response.usage);
	}
	const text = contentText(response.content).trim();
	if (text.length === 0) {
		throw new InContextCompactionError("In-context summarization returned no text", response.usage);
	}

	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	return {
		summary: text + formatFileOperations(readFiles, modifiedFiles),
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		usage: response.usage,
		details: { readFiles, modifiedFiles, inContext: { status: "used" } } satisfies CompactionDetails,
	};
}
