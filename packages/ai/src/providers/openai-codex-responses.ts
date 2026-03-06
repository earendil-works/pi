import os from "node:os";
import type {
	ResponseFunctionToolCall,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "openai/resources/responses/responses.js";
import { getMuCompactResponseItem } from "../compact-history.js";
import { MU_STATIC_INSTRUCTIONS } from "../constants.js";
import { calculateCost } from "../models.js";
import { getEnvApiKey } from "../stream.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	OpenAICodexResponsesOptions,
	RetryClass,
	StopReason,
	StreamFunction,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { getOAuthApiKey } from "../utils/oauth/index.js";
import { listOAuthAccounts, markOAuthAccountCooldown } from "../utils/oauth/storage.js";
import { getExponentialBackoff, sleep } from "../utils/retry.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { parseCodexError, parseCodexRateLimits } from "./openai-codex/response-handler.js";
import { buildCodexMuBridge, OPENCODE_CODEX_INSTRUCTIONS } from "./openai-codex-responses-legacy.js";
import {
	normalizeToolNameWithTools,
	recoverToolCallFromTextContent,
	upsertToolCallContent,
} from "./tool-call-recovery.js";
import { transformMessages } from "./transform-messages.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * When true, uses the legacy OpenCode/Codex system prompt with bridge injection.
 * When false (default), uses the new Pi static instructions.
 */
const USE_LEGACY_CODEX_PROMPT = false;

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

/**
 * Sanitize tool call ID to meet OpenAI Codex requirements:
 * - Max 64 characters
 * - Must start with "fc_" for item IDs
 * - Only alphanumeric, underscore, hyphen allowed
 * - No trailing underscores
 */
export function sanitizeToolCallId(id: string): { callId: string; itemId: string } {
	const parts = id.split("|");
	const rawCallId = parts[0] ?? id;
	const rawItemId = parts[1] ?? "";
	const effectiveItemId = rawItemId || rawCallId;

	const sanitize = (s: string, prefix?: string): string => {
		// Replace special chars with underscore
		let result = s.replace(/[^a-zA-Z0-9_-]/g, "_");
		// Ensure prefix
		if (prefix && !result.startsWith(prefix)) {
			result = `${prefix}${result}`;
		}
		// Truncate to 64 chars
		if (result.length > 64) {
			result = result.slice(0, 64);
		}
		// Strip trailing underscores (but preserve prefix)
		const prefixLen = prefix?.length ?? 0;
		const beforeTrailing = result.slice(0, prefixLen);
		const afterPrefix = result.slice(prefixLen).replace(/_+$/, "");
		result = beforeTrailing + afterPrefix;
		return result;
	};

	return {
		callId: sanitize(rawCallId),
		itemId: sanitize(effectiveItemId, "fc_"),
	};
}

// ============================================================================
// Types
// ============================================================================

interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	service_tier?: "priority";
	instructions?: string;
	input?: unknown[];
	tools?: unknown;
	tool_choice?: "auto";
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

export class CodexHttpError extends Error {
	readonly status: number;
	readonly retryAfterMs?: number;

	constructor(message: string, status: number, retryAfterMs?: number) {
		super(message);
		this.name = "CodexHttpError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

class CodexStreamError extends Error {
	readonly hadContent: boolean;

	constructor(message: string, hadContent: boolean) {
		super(message);
		this.name = "CodexStreamError";
		this.hadContent = hadContent;
	}
}

const DEFAULT_RETRY_CLASSES: RetryClass[] = ["429", "5xx", "transport"];

function isGptFamilyModelId(modelId: string): boolean {
	const normalized = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	return normalized.toLowerCase().startsWith("gpt");
}

function toServiceUsageLimits(rateLimits: ReturnType<typeof parseCodexRateLimits>): AssistantMessage["usageLimits"] {
	if (!rateLimits) return undefined;

	const mapWindow = (window?: { used_percent?: number; window_minutes?: number; resets_at?: number }) => {
		if (!window || window.used_percent === undefined) return undefined;
		return {
			usedPercent: window.used_percent,
			windowMinutes: window.window_minutes,
			resetsAt: window.resets_at,
		};
	};

	const primary = mapWindow(rateLimits.primary);
	const secondary = mapWindow(rateLimits.secondary);
	return primary || secondary ? { primary, secondary } : undefined;
}

function getRetryAfterMs(headers: Headers): number | undefined {
	const raw = headers.get("retry-after") ?? headers.get("Retry-After");
	if (!raw) return undefined;

	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return seconds * 1000;

	const date = Date.parse(raw);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

	return undefined;
}

function getErrorStatus(error: unknown): number | undefined {
	if (error instanceof CodexHttpError) return error.status;
	if (!error || typeof error !== "object") return undefined;

	const record = error as Record<string, unknown>;
	const status = record.status;
	if (typeof status === "number") return status;
	if (typeof status === "string" && status.trim()) {
		const parsed = Number(status);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : JSON.stringify(error);
}

function getRetryAfterFromError(error: unknown): number | undefined {
	if (error instanceof CodexHttpError) return error.retryAfterMs;
	if (!error || typeof error !== "object") return undefined;

	const record = error as Record<string, unknown>;
	const retryAfter = record.retryAfterMs;
	return typeof retryAfter === "number" ? retryAfter : undefined;
}

function resolveRetryClasses(retryOn?: RetryClass[]): RetryClass[] {
	return retryOn && retryOn.length > 0 ? retryOn : DEFAULT_RETRY_CLASSES;
}

function hasRetryClass(classes: RetryClass[], value: RetryClass): boolean {
	return classes.includes(value);
}

function isTransportErrorMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("terminated") ||
		normalized.includes("fetch failed") ||
		normalized.includes("network") ||
		normalized.includes("econnreset") ||
		normalized.includes("etimedout") ||
		normalized.includes("econnrefused") ||
		// Seen from OpenAI/Codex edge when it fails to retry an upstream request.
		normalized.includes("request buffer") ||
		normalized.includes("buffer limit")
	);
}

const DEFAULT_COOLDOWN_MS = 60_000;

function parseCooldownFromMessage(message: string): number | null {
	const match = message.match(/try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?|minutes?|hours?)/i);
	if (!match) return null;

	const value = Number.parseFloat(match[1]);
	if (!Number.isFinite(value)) return null;

	const unit = match[2].toLowerCase();
	if (unit === "ms") return Math.round(value);
	if (unit === "s" || unit.startsWith("second")) return Math.round(value * 1000);
	if (unit.startsWith("minute")) return Math.round(value * 60_000);
	if (unit.startsWith("hour")) return Math.round(value * 3_600_000);

	return null;
}

function classifyCooldown(error: unknown): { shouldCooldown: boolean; cooldownMs: number } {
	const status = getErrorStatus(error);
	const message = getErrorMessage(error).toLowerCase();
	const retryAfterMs = getRetryAfterFromError(error);
	const parsedCooldown = parseCooldownFromMessage(message);

	if (status === 429) {
		return { shouldCooldown: true, cooldownMs: retryAfterMs ?? parsedCooldown ?? DEFAULT_COOLDOWN_MS };
	}

	const rateLimitHint =
		message.includes("rate limit") ||
		message.includes("rate_limit") ||
		message.includes("usage limit") ||
		message.includes("too many requests");
	if (rateLimitHint) {
		return { shouldCooldown: true, cooldownMs: retryAfterMs ?? parsedCooldown ?? DEFAULT_COOLDOWN_MS };
	}

	if ((status !== undefined && status >= 500 && status <= 504) || isTransportErrorMessage(message)) {
		return { shouldCooldown: true, cooldownMs: DEFAULT_COOLDOWN_MS };
	}

	return { shouldCooldown: false, cooldownMs: 0 };
}

export function isRetryableCodexError(error: unknown, signal?: AbortSignal, retryOn?: RetryClass[]): boolean {
	if (signal?.aborted) return false;

	const classes = resolveRetryClasses(retryOn);

	if (error instanceof CodexStreamError) {
		return !error.hadContent && hasRetryClass(classes, "transport");
	}

	const status = getErrorStatus(error);
	if (status === 429 && hasRetryClass(classes, "429")) {
		return true;
	}
	if (status !== undefined && status >= 500 && status <= 504 && hasRetryClass(classes, "5xx")) {
		return true;
	}

	if (!hasRetryClass(classes, "transport")) {
		return false;
	}

	return isTransportErrorMessage(getErrorMessage(error));
}

export function getRetryDelay(attempt: number, baseDelay: number, maxDelay: number, error: unknown): number {
	const backoff = getExponentialBackoff(attempt, baseDelay, maxDelay);
	const retryAfterMs = getRetryAfterFromError(error);
	if (retryAfterMs === undefined) return Math.min(maxDelay, backoff);
	return Math.min(maxDelay, Math.max(backoff, retryAfterMs));
}

function resolveCodexRetryOptions(options?: OpenAICodexResponsesOptions): {
	requestMaxRetries: number;
	streamMaxRetries: number;
	baseDelay: number;
	maxDelay: number;
	retryOn: RetryClass[];
} {
	const fallbackRetry = options?.retry;
	const codexRetry = options?.codexRetry;

	return {
		requestMaxRetries: codexRetry?.requestMaxRetries ?? fallbackRetry?.maxRetries ?? 3,
		streamMaxRetries: codexRetry?.streamMaxRetries ?? fallbackRetry?.maxRetries ?? 1,
		baseDelay: codexRetry?.baseDelay ?? fallbackRetry?.baseDelay ?? 1000,
		maxDelay: codexRetry?.maxDelay ?? fallbackRetry?.maxDelay ?? 60000,
		retryOn: resolveRetryClasses(codexRetry?.retryOn),
	};
}

function isStoredOAuthAccessToken(token: string): boolean {
	const accounts = listOAuthAccounts("openai-codex");
	return accounts.some((account) => account.credentials.access === token);
}

async function resolveCodexApiKey(
	modelProvider: string,
	explicitKey?: string,
): Promise<{ apiKey: string; fromOAuth: boolean }> {
	const explicitMatchesOAuth = explicitKey ? isStoredOAuthAccessToken(explicitKey) : false;

	if (explicitKey && !explicitMatchesOAuth) {
		return { apiKey: explicitKey, fromOAuth: false };
	}

	const oauthKey = await getOAuthApiKey("openai-codex");
	if (oauthKey) {
		return { apiKey: oauthKey, fromOAuth: true };
	}

	if (explicitKey) {
		return { apiKey: explicitKey, fromOAuth: explicitMatchesOAuth };
	}

	const envKey = getEnvApiKey(modelProvider);
	if (!envKey) {
		throw new Error(`No API key for provider: ${modelProvider}`);
	}

	return { apiKey: envKey, fromOAuth: false };
}

function tryMarkCodexCooldown(apiKey: string, cooldownMs: number): void {
	try {
		const accountId = extractAccountId(apiKey);
		markOAuthAccountCooldown("openai-codex", accountId, cooldownMs);
	} catch {
		// ignore cooldown marking failures
	}
}

// ============================================================================
// Main Stream Function
// ============================================================================

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses"> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const retryConfig = resolveCodexRetryOptions(options);
		const { requestMaxRetries, streamMaxRetries, baseDelay, maxDelay, retryOn } = retryConfig;

		let hasEmittedStart = false;
		let attempts = 0;
		let lastError: unknown;
		let lastApiKey: string | null = null;
		let lastApiKeyWasOAuth = false;
		let lastCooldownMarkedKey: string | null = null;
		let streamRetries = 0;
		let requestAttempt = 0;

		while (true) {
			const attemptIndex = requestAttempt;
			requestAttempt += 1;
			attempts = requestAttempt;
			try {
				output.content = [];
				output.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};

				const resolvedKey = await resolveCodexApiKey(model.provider, options?.apiKey);
				const apiKey = resolvedKey.apiKey;
				lastApiKey = apiKey;
				lastApiKeyWasOAuth = resolvedKey.fromOAuth;

				const accountId = extractAccountId(apiKey);
				const body = buildRequestBody(model, context, options);
				const headers = buildHeaders(model.headers, accountId, apiKey, options?.sessionId);

				const response = await fetch(CODEX_URL, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: options?.signal,
				});
				output.usageLimits = toServiceUsageLimits(parseCodexRateLimits(response.headers));

				if (!response.ok) {
					const info = await parseCodexError(response);
					output.usageLimits = toServiceUsageLimits(info.rateLimits) ?? output.usageLimits;
					const retryAfterMs = getRetryAfterMs(response.headers);
					throw new CodexHttpError(info.friendlyMessage || info.message, response.status, retryAfterMs);
				}

				if (!response.body) {
					throw new Error("No response body");
				}

				if (!hasEmittedStart) {
					stream.push({ type: "start", partial: output });
					hasEmittedStart = true;
				}

				await processStream(response, output, stream, model, context.tools);

				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				if (output.stopReason === "error" || output.stopReason === "aborted") {
					throw new Error(output.errorMessage || "Codex response failed");
				}

				stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
				stream.end();
				return;
			} catch (error) {
				lastError = error;
				const cooldown = classifyCooldown(error);

				const canRetryStream =
					!options?.signal?.aborted &&
					hasRetryClass(retryOn, "transport") &&
					streamRetries < streamMaxRetries &&
					((error instanceof CodexStreamError && !error.hadContent) ||
						(hasEmittedStart && isTransportErrorMessage(getErrorMessage(error))));

				if (canRetryStream) {
					const streamAttempt = streamRetries;
					streamRetries += 1;
					const delay = getRetryDelay(streamAttempt, baseDelay, maxDelay, error);
					try {
						await sleep(delay, options?.signal);
					} catch {
						break;
					}
					continue;
				}

				const shouldRetryRequest =
					!hasEmittedStart &&
					isRetryableCodexError(error, options?.signal, retryOn) &&
					attemptIndex < requestMaxRetries;

				if (shouldRetryRequest) {
					if (cooldown.shouldCooldown && lastApiKey && lastApiKeyWasOAuth) {
						if (lastApiKey !== lastCooldownMarkedKey) {
							tryMarkCodexCooldown(lastApiKey, cooldown.cooldownMs);
							lastCooldownMarkedKey = lastApiKey;
						}
					}
					const delay = getRetryDelay(attemptIndex, baseDelay, maxDelay, error);
					try {
						await sleep(delay, options?.signal);
					} catch {
						break;
					}
					continue;
				}
				break;
			}
		}

		if (!hasEmittedStart) {
			stream.push({ type: "start", partial: output });
		}

		if (lastError && !options?.signal?.aborted) {
			const cooldown = classifyCooldown(lastError);
			if (cooldown.shouldCooldown && lastApiKey && lastApiKeyWasOAuth && lastApiKey !== lastCooldownMarkedKey) {
				tryMarkCodexCooldown(lastApiKey, cooldown.cooldownMs);
			}
		}

		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		const errorMessage = getErrorMessage(lastError ?? "Unknown error");
		output.errorMessage = attempts > 1 ? `${errorMessage} (after ${attempts} attempts)` : errorMessage;
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	})();

	return stream;
};

// ============================================================================
// Request Building
// ============================================================================

function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): RequestBody {
	const systemPrompt = buildSystemPrompt(context.systemPrompt, context.tools);
	const messages = convertMessages(model, context);

	// Prepend developer messages
	const developerMessages = systemPrompt.developerMessages.map((text) => ({
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text }],
	}));

	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: systemPrompt.instructions,
		input: [...developerMessages, ...messages],
		text: { verbosity: options?.textVerbosity || "medium" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: options?.parallelToolCalls ?? false,
	};

	if (options?.fastMode && isGptFamilyModelId(model.id)) {
		body.service_tier = "priority";
	}

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (context.tools) {
		body.tools = context.tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: false,
		}));
	}

	if (options?.reasoningEffort !== undefined) {
		body.reasoning = {
			effort: clampReasoningEffort(model.id, options.reasoningEffort),
			summary: options.reasoningSummary ?? "auto",
		};
	}

	return body;
}

function buildSystemPrompt(
	userSystemPrompt?: string,
	tools?: Tool[],
): { instructions: string; developerMessages: string[] } {
	if (USE_LEGACY_CODEX_PROMPT) {
		const developerMessages: string[] = [];
		const bridgeText = buildCodexMuBridge(tools);
		if (bridgeText.trim()) developerMessages.push(bridgeText.trim());
		if (userSystemPrompt?.trim()) developerMessages.push(userSystemPrompt.trim());
		return { instructions: OPENCODE_CODEX_INSTRUCTIONS, developerMessages };
	}

	const staticPrefix = MU_STATIC_INSTRUCTIONS.trim();
	const staticInstructions = `<system_instructions>\n${staticPrefix}\n</system_instructions>`;
	const developerMessages: string[] = [];

	if (userSystemPrompt?.trim()) {
		let dynamicPart = userSystemPrompt.trim();
		if (dynamicPart.startsWith(staticInstructions)) {
			dynamicPart = dynamicPart.slice(staticInstructions.length).trim();
		} else if (dynamicPart.startsWith(staticPrefix)) {
			dynamicPart = dynamicPart.slice(staticPrefix.length).trim();
		}
		if (dynamicPart) developerMessages.push(dynamicPart);
	}

	return { instructions: staticInstructions, developerMessages };
}

function clampReasoningEffort(modelId: string, effort: string): string {
	const id = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}

// ============================================================================
// Message Conversion
// ============================================================================

function shouldReplayAssistantMessage(msg: AssistantMessage): boolean {
	return msg.stopReason !== "error" && msg.stopReason !== "aborted";
}

function convertMessages(model: Model<"openai-codex-responses">, context: Context): unknown[] {
	const messages: unknown[] = [];
	const replayableToolCallIds = new Set<string>();
	const transformed = transformMessages(context.messages, model);

	for (const msg of transformed) {
		const rawCompactItem = getMuCompactResponseItem(msg);
		if (rawCompactItem) {
			messages.push(rawCompactItem);
			continue;
		}

		if (msg.role === "user") {
			messages.push(convertUserMessage(msg, model));
		} else if (msg.role === "assistant") {
			if (!shouldReplayAssistantMessage(msg)) {
				continue;
			}
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					replayableToolCallIds.add(block.id);
				}
			}
			messages.push(...convertAssistantMessage(msg));
		} else if (msg.role === "toolResult") {
			if (!replayableToolCallIds.has(msg.toolCallId)) {
				continue;
			}
			messages.push(...convertToolResult(msg, model));
		}
	}

	return messages.filter(Boolean);
}

function convertUserMessage(
	msg: { content: string | Array<{ type: string; text?: string; mimeType?: string; data?: string }> },
	model: Model<"openai-codex-responses">,
): unknown {
	if (typeof msg.content === "string") {
		return {
			role: "user",
			content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
		};
	}

	const content = msg.content.map((item) => {
		if (item.type === "text") {
			return { type: "input_text", text: sanitizeSurrogates(item.text || "") };
		}
		return {
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		};
	});

	const filtered = model.input.includes("image") ? content : content.filter((c) => c.type !== "input_image");
	return filtered.length > 0 ? { role: "user", content: filtered } : null;
}

function convertAssistantMessage(msg: AssistantMessage): unknown[] {
	const output: unknown[] = [];

	for (const block of msg.content) {
		if (block.type === "thinking" && block.thinkingSignature) {
			output.push(JSON.parse(block.thinkingSignature));
		} else if (block.type === "text") {
			output.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
				status: "completed",
			});
		} else if (block.type === "toolCall") {
			const { callId, itemId } = sanitizeToolCallId(block.id);
			output.push({
				type: "function_call",
				id: itemId,
				call_id: callId,
				name: block.name,
				arguments: JSON.stringify(block.arguments),
			});
		}
	}

	return output;
}

function convertToolResult(
	msg: { toolCallId: string; content: Array<{ type: string; text?: string; mimeType?: string; data?: string }> },
	model: Model<"openai-codex-responses">,
): unknown[] {
	const output: unknown[] = [];
	const textResult = msg.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
	const hasImages = msg.content.some((c) => c.type === "image");

	const { callId } = sanitizeToolCallId(msg.toolCallId);
	output.push({
		type: "function_call_output",
		call_id: callId,
		output: sanitizeSurrogates(textResult || "(see attached image)"),
	});

	if (hasImages && model.input.includes("image")) {
		const imageParts = msg.content
			.filter((c) => c.type === "image")
			.map((c) => ({
				type: "input_image",
				detail: "auto",
				image_url: `data:${c.mimeType};base64,${c.data}`,
			}));

		output.push({
			role: "user",
			content: [{ type: "input_text", text: "Attached image(s) from tool result:" }, ...imageParts],
		});
	}

	return output;
}

// ============================================================================
// Response Processing
// ============================================================================

type CodexCustomToolCall = {
	type: "custom_tool_call";
	call_id: string;
	name: string;
	id?: string;
	input?: string;
	status?: string;
};

type CodexLocalShellCall = {
	type: "local_shell_call";
	id?: string;
	call_id?: string;
	status?: string;
	action?: {
		type?: string;
		command?: string | string[];
		[key: string]: unknown;
	};
};

type CodexResponseItem =
	| ResponseReasoningItem
	| ResponseOutputMessage
	| ResponseFunctionToolCall
	| CodexCustomToolCall
	| CodexLocalShellCall;

function normalizeToolName(name: string, tools: Tool[] | undefined): string {
	return normalizeToolNameWithTools(name, tools);
}

function buildToolCallId(callId: string | undefined, itemId: string | undefined): string {
	const lhs = callId ?? itemId ?? "";
	const rhs = itemId ?? callId ?? "";
	return `${lhs}|${rhs}`;
}

function parseToolArgumentsForName(raw: string | undefined, toolName: string): Record<string, unknown> {
	const parsed = parseToolArgumentsSafely(raw);
	if (Object.keys(parsed).length > 0) return parsed;

	const text = raw?.trim() ?? "";
	if (!text) return {};

	const normalizedName = normalizeToolName(toolName, undefined);
	if (normalizedName === "apply_patch") {
		return { input: text };
	}

	return { input: text };
}

function getLocalShellCommand(item: CodexLocalShellCall): string {
	const action = asRecord(item.action);
	const command = action?.command;
	if (typeof command === "string") return command;
	if (Array.isArray(command)) {
		const parts = command.filter((part): part is string => typeof part === "string" && part.length > 0);
		return parts.join(" ");
	}
	return "";
}

async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	tools: Tool[] | undefined,
): Promise<void> {
	let currentItem: CodexResponseItem | null = null;
	let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson?: string }) | null = null;
	let sawCompletion = false;
	let hadContent = false;
	let parseErrorCount = 0;
	let sawToolIntent = false;
	const blockIndex = () => output.content.length - 1;

	for await (const event of parseSSE(response)) {
		const type = event.type as string;
		if (type === "__parse_error__") {
			parseErrorCount++;
			continue;
		}

		switch (type) {
			case "response.output_item.added": {
				const item = event.item as CodexResponseItem;
				if (item.type === "reasoning") {
					hadContent = true;
					currentItem = item;
					currentBlock = { type: "thinking", thinking: "" };
					output.content.push(currentBlock);
					stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
				} else if (item.type === "message") {
					hadContent = true;
					currentItem = item;
					currentBlock = { type: "text", text: "" };
					output.content.push(currentBlock);
					stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
				} else if (item.type === "function_call") {
					hadContent = true;
					currentItem = item;
					const normalizedName = normalizeToolName(item.name, tools);
					currentBlock = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: normalizedName,
						arguments: {},
						partialJson: item.arguments || "",
					};
					output.content.push(currentBlock);
					stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
				} else if (item.type === "custom_tool_call") {
					hadContent = true;
					currentItem = item;
					const rawInput = item.input || "";
					const normalizedName = normalizeToolName(item.name, tools);
					currentBlock = {
						type: "toolCall",
						id: buildToolCallId(item.call_id, item.id),
						name: normalizedName,
						arguments: parseToolArgumentsForName(rawInput, item.name),
						partialJson: rawInput,
					};
					output.content.push(currentBlock);
					stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
				} else if (item.type === "local_shell_call") {
					hadContent = true;
					currentItem = item;
					const command = getLocalShellCommand(item);
					const rawInput = command ? JSON.stringify({ cmd: command }) : "";
					currentBlock = {
						type: "toolCall",
						id: buildToolCallId(item.call_id, item.id),
						name: "exec_command",
						arguments: command ? { cmd: command } : {},
						partialJson: rawInput,
					};
					output.content.push(currentBlock);
					stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
				}
				break;
			}

			case "response.reasoning_summary_part.added": {
				if (currentItem?.type === "reasoning") {
					currentItem.summary = currentItem.summary || [];
					currentItem.summary.push((event as { part: ResponseReasoningItem["summary"][number] }).part);
				}
				break;
			}

			case "response.reasoning_summary_text.delta": {
				if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
					const delta = (event as { delta?: string }).delta || "";
					const lastPart = currentItem.summary?.[currentItem.summary.length - 1];
					if (lastPart) {
						currentBlock.thinking += delta;
						lastPart.text += delta;
						stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta, partial: output });
					}
				}
				break;
			}

			case "response.reasoning_summary_part.done": {
				if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
					const lastPart = currentItem.summary?.[currentItem.summary.length - 1];
					if (lastPart) {
						currentBlock.thinking += "\n\n";
						lastPart.text += "\n\n";
						stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta: "\n\n", partial: output });
					}
				}
				break;
			}

			case "response.content_part.added": {
				if (currentItem?.type === "message") {
					currentItem.content = currentItem.content || [];
					const part = (event as { part?: ResponseOutputMessage["content"][number] }).part;
					if (part && (part.type === "output_text" || part.type === "refusal")) {
						currentItem.content.push(part);
					}
				}
				break;
			}

			case "response.output_text.delta": {
				if (currentItem?.type === "message" && currentBlock?.type === "text") {
					const lastPart = currentItem.content[currentItem.content.length - 1];
					if (lastPart?.type === "output_text") {
						const delta = (event as { delta?: string }).delta || "";
						currentBlock.text += delta;
						lastPart.text += delta;
						stream.push({ type: "text_delta", contentIndex: blockIndex(), delta, partial: output });
					}
				}
				break;
			}

			case "response.refusal.delta": {
				if (currentItem?.type === "message" && currentBlock?.type === "text") {
					const lastPart = currentItem.content[currentItem.content.length - 1];
					if (lastPart?.type === "refusal") {
						const delta = (event as { delta?: string }).delta || "";
						currentBlock.text += delta;
						lastPart.refusal += delta;
						stream.push({ type: "text_delta", contentIndex: blockIndex(), delta, partial: output });
					}
				}
				break;
			}

			case "response.function_call_arguments.delta": {
				if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
					sawToolIntent = true;
					const delta = (event as { delta?: string }).delta || "";
					currentBlock.partialJson += delta;
					currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
					stream.push({ type: "toolcall_delta", contentIndex: blockIndex(), delta, partial: output });
				}
				break;
			}

			case "response.function_call_arguments.done": {
				if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
					sawToolIntent = true;
					const args = (event as { arguments?: string }).arguments || "";
					currentBlock.partialJson = args;
					currentBlock.arguments = parseStreamingJson(args);
				}
				break;
			}

			case "response.custom_tool_call_input.delta": {
				if (currentItem?.type === "custom_tool_call" && currentBlock?.type === "toolCall") {
					sawToolIntent = true;
					const delta = (event as { delta?: string }).delta || "";
					currentBlock.partialJson += delta;
					currentBlock.arguments = parseToolArgumentsForName(currentBlock.partialJson, currentItem.name);
					stream.push({ type: "toolcall_delta", contentIndex: blockIndex(), delta, partial: output });
				}
				break;
			}

			case "response.custom_tool_call_input.done": {
				if (currentItem?.type === "custom_tool_call" && currentBlock?.type === "toolCall") {
					sawToolIntent = true;
					const input = (event as { input?: string }).input || currentBlock.partialJson;
					currentBlock.partialJson = input;
					currentBlock.arguments = parseToolArgumentsForName(input, currentItem.name);
				}
				break;
			}

			case "response.output_item.done": {
				const item = event.item as CodexResponseItem;
				if (item.type === "reasoning") {
					hadContent = true;
					const activeThinkingBlock = currentBlock?.type === "thinking" ? currentBlock : null;
					const hadActiveThinkingBlock = activeThinkingBlock !== null;
					const thinkingBlock: ThinkingContent =
						activeThinkingBlock ?? ({ type: "thinking", thinking: "" } as ThinkingContent);
					if (!hadActiveThinkingBlock) {
						output.content.push(thinkingBlock);
						stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
					}
					thinkingBlock.thinking = item.summary?.map((s) => s.text).join("\n\n") || "";
					thinkingBlock.thinkingSignature = JSON.stringify(item);
					const contentIndex = output.content.indexOf(thinkingBlock);
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: thinkingBlock.thinking,
						partial: output,
					});
					if (hadActiveThinkingBlock) currentBlock = null;
				} else if (item.type === "message") {
					hadContent = true;
					const activeTextBlock = currentBlock?.type === "text" ? currentBlock : null;
					const hadActiveTextBlock = activeTextBlock !== null;
					const textBlock: TextContent = activeTextBlock ?? ({ type: "text", text: "" } as TextContent);
					if (!hadActiveTextBlock) {
						output.content.push(textBlock);
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}
					textBlock.text = item.content.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("");
					textBlock.textSignature = item.id;
					const contentIndex = output.content.indexOf(textBlock);
					stream.push({
						type: "text_end",
						contentIndex,
						content: textBlock.text,
						partial: output,
					});
					if (hadActiveTextBlock) currentBlock = null;
				} else if (item.type === "function_call") {
					const normalizedName = normalizeToolName(item.name, tools);
					// Use accumulated partialJson as fallback if item.arguments is empty/missing
					const argsStr =
						item.arguments || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "{}") || "{}";
					const args = parseToolArgumentsSafely(argsStr);
					if (currentBlock?.type === "toolCall") {
						currentBlock.partialJson = argsStr;
						currentBlock.arguments = args;
						delete currentBlock.partialJson;
					}
					const toolCall: ToolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: normalizedName,
						arguments: args,
					};
					const { contentIndex, inserted } = upsertToolCallContent(output.content, toolCall);
					if (inserted) {
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
					}
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
					currentBlock = null;
				} else if (item.type === "custom_tool_call") {
					const rawInput = item.input || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "");
					const toolName = normalizeToolName(item.name, tools);
					const args = parseToolArgumentsForName(rawInput, toolName);
					if (currentBlock?.type === "toolCall") {
						currentBlock.partialJson = rawInput;
						currentBlock.arguments = args;
						delete currentBlock.partialJson;
					}
					const toolCall: ToolCall = {
						type: "toolCall",
						id: buildToolCallId(item.call_id, item.id),
						name: toolName,
						arguments: args,
					};
					const { contentIndex, inserted } = upsertToolCallContent(output.content, toolCall);
					if (inserted) {
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
					}
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
					currentBlock = null;
				} else if (item.type === "local_shell_call") {
					const command = getLocalShellCommand(item);
					const args = command ? { cmd: command } : {};
					if (currentBlock?.type === "toolCall") {
						currentBlock.arguments = args;
						delete currentBlock.partialJson;
					}
					const toolCall: ToolCall = {
						type: "toolCall",
						id: buildToolCallId(item.call_id, item.id),
						name: "exec_command",
						arguments: args,
					};
					const { contentIndex, inserted } = upsertToolCallContent(output.content, toolCall);
					if (inserted) {
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
					}
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
					currentBlock = null;
				}
				break;
			}

			case "response.incomplete": {
				const resp = asRecord((event as { response?: unknown }).response);
				const details = asRecord(resp?.incomplete_details);
				const reason = getString(details?.reason) ?? "unknown";
				throw new CodexStreamError(`Incomplete response returned, reason: ${reason}`, hadContent);
			}

			case "response.completed":
			case "response.done": {
				sawCompletion = true;
				const resp = (
					event as {
						response?: {
							usage?: {
								input_tokens?: number;
								output_tokens?: number;
								total_tokens?: number;
								input_tokens_details?: { cached_tokens?: number };
							};
							status?: string;
						};
					}
				).response;
				if (resp?.usage) {
					const cached = resp.usage.input_tokens_details?.cached_tokens || 0;
					output.usage = {
						input: (resp.usage.input_tokens || 0) - cached,
						output: resp.usage.output_tokens || 0,
						cacheRead: cached,
						cacheWrite: 0,
						totalTokens: resp.usage.total_tokens || 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
				}
				calculateCost(model, output.usage);

				if (resp?.status === "queued" || resp?.status === "in_progress") {
					throw new CodexStreamError(`Stream ended with non-terminal status: ${resp.status}`, hadContent);
				}

				output.stopReason = mapStopReason(resp?.status);
				if (output.stopReason === "stop" && !output.content.some((b) => b.type === "toolCall")) {
					const recoveredToolCall = recoverToolCallFromTextContent(
						output.content,
						tools,
						(name) => normalizeToolName(name, tools),
						(raw) => parseToolArgumentsSafely(raw),
					);
					if (recoveredToolCall) {
						const { contentIndex, inserted } = upsertToolCallContent(output.content, recoveredToolCall);
						if (inserted) {
							stream.push({ type: "toolcall_start", contentIndex, partial: output });
						}
						stream.push({
							type: "toolcall_end",
							contentIndex,
							toolCall: recoveredToolCall,
							partial: output,
						});
					}
				}
				const hasToolCall = output.content.some((b) => b.type === "toolCall");
				if (sawToolIntent && !hasToolCall) {
					throw new CodexStreamError("Tool intent observed but no toolCall materialized", hadContent);
				}
				if (hasToolCall && output.stopReason === "stop") {
					output.stopReason = "toolUse";
				}
				break;
			}

			case "error": {
				const code = (event as { code?: string }).code || "";
				const message = (event as { message?: string }).message || "";
				throw new Error(formatCodexErrorEvent(event, code, message));
			}

			case "response.failed": {
				throw new Error(formatCodexFailure(event) ?? "Codex response failed");
			}
		}
	}

	if (!sawCompletion) {
		const suffix = parseErrorCount > 0 ? ` (parseErrors=${parseErrorCount})` : "";
		throw new CodexStreamError(`Stream terminated before completion${suffix}`, hadContent);
	}
}

// ============================================================================
// Headers
// ============================================================================

function buildHeaders(
	initHeaders: Record<string, string> | undefined,
	accountId: string,
	accessToken: string,
	sessionId?: string,
): Headers {
	const headers = new Headers(initHeaders ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "mu");
	headers.set("User-Agent", `pi (${os.platform()} ${os.release()}; ${os.arch()})`);

	headers.delete("OpenAI-Organization");
	headers.delete("OpenAI-Organization-Context");
	headers.delete("OpenAI-Conversation-ID");
	headers.delete("OpenAI-Session-ID");

	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("conversation_id", sessionId);
	} else {
		headers.delete("session_id");
		headers.delete("conversation_id");
	}

	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	return headers;
}

// ============================================================================
// JSON Parsing
// ============================================================================

function parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	const decoder = new TextDecoder();
	let buffer = "";

	if (!response.body) return (async function* () {})();

	const reader = response.body.getReader();

	const parseChunk = (chunk: string): { done: boolean; event?: Record<string, unknown> } => {
		if (!chunk.trim()) return { done: false };

		const dataLines = chunk
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim());

		if (dataLines.length === 0) return { done: false };

		const data = dataLines.join("\n");
		if (data === "[DONE]") return { done: true };

		try {
			const json = JSON.parse(data) as Record<string, unknown>;
			return { done: false, event: json };
		} catch (error) {
			const compact = dataLines.join("");
			if (compact !== data) {
				try {
					const json = JSON.parse(compact) as Record<string, unknown>;
					return { done: false, event: json };
				} catch {
					// Fall through to parse error marker below
				}
			}
			console.warn("Failed to parse SSE JSON:", error);
			return {
				done: false,
				event: {
					type: "__parse_error__",
				},
			};
		}
	};

	async function* generator(): AsyncGenerator<Record<string, unknown>> {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");

			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const chunk = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf("\n\n");

				const result = parseChunk(chunk);
				if (result.done) return;
				if (result.event) yield result.event;
			}
		}

		if (buffer.trim()) {
			const result = parseChunk(buffer);
			if (result.done) return;
			if (result.event) yield result.event;
		}
	}

	return generator();
}

function tryParseObject(json: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(json);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// ignore parse errors
	}
	return null;
}

function parseToolArgumentsSafely(raw: string | undefined): Record<string, unknown> {
	const source = raw ?? "";
	if (!source.trim()) return {};

	const parsed = tryParseObject(source);
	if (parsed) return parsed;

	const firstBrace = source.indexOf("{");
	const lastBrace = source.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		const candidate = source.slice(firstBrace, lastBrace + 1);
		const candidateParsed = tryParseObject(candidate);
		if (candidateParsed) return candidateParsed;
	}

	return {};
}

// ============================================================================
// Error Handling
// ============================================================================

function formatCodexErrorEvent(event: Record<string, unknown>, code: string, message: string): string {
	return `Codex error (${code}): ${message || JSON.stringify(event)}`;
}

function formatCodexFailure(rawEvent: Record<string, unknown>): string | null {
	const response = asRecord(rawEvent.response);
	const error = asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);

	const message = getString(error?.message) ?? getString(rawEvent.message) ?? getString(response?.message);
	const code = getString(error?.code) ?? getString(error?.type) ?? getString(rawEvent.code);

	if (!message && !code) return null;
	return code ? `Codex response failed (${code}): ${message || "Unknown error"}` : `Codex response failed: ${message}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object") {
		return value as Record<string, unknown>;
	}
	return null;
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

// ============================================================================
// Stop Reason Mapping
// ============================================================================

function mapStopReason(status: string | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
		case "in_progress":
		case "queued":
			return "error";
		default:
			return "error";
	}
}

// ============================================================================
// JWT
// ============================================================================

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
};

function decodeJwt(token: string): JwtPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = Buffer.from(payload, "base64").toString("utf-8");
		return JSON.parse(decoded) as JwtPayload;
	} catch {
		return null;
	}
}

function extractAccountId(accessToken: string): string {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}

	return accountId;
}
