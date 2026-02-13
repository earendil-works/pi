import os from "node:os";
import { MU_STATIC_INSTRUCTIONS } from "../constants.js";
import { calculateCost } from "../models.js";
import { getEnvApiKey } from "../stream.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { getOAuthApiKey } from "../utils/oauth/index.js";
import { listOAuthAccounts, markOAuthAccountCooldown } from "../utils/oauth/storage.js";
import { getExponentialBackoff, sleep } from "../utils/retry.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { buildCodexMuBridge, OPENCODE_CODEX_INSTRUCTIONS } from "./openai-codex-responses-legacy.js";
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
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
/**
 * Sanitize tool call ID to meet OpenAI Codex requirements:
 * - Max 64 characters
 * - Must start with "fc_" for item IDs
 * - Only alphanumeric, underscore, hyphen allowed
 * - No trailing underscores
 */
export function sanitizeToolCallId(id) {
	const parts = id.split("|");
	const rawCallId = parts[0] ?? id;
	const rawItemId = parts[1] ?? "";
	const sanitize = (s, prefix) => {
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
		itemId: sanitize(rawItemId, "fc_"),
	};
}
export class CodexHttpError extends Error {
	status;
	retryAfterMs;
	constructor(message, status, retryAfterMs) {
		super(message);
		this.name = "CodexHttpError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}
class CodexStreamError extends Error {
	hadContent;
	constructor(message, hadContent) {
		super(message);
		this.name = "CodexStreamError";
		this.hadContent = hadContent;
	}
}
const DEFAULT_RETRY_CLASSES = ["429", "5xx", "transport"];
function getRetryAfterMs(headers) {
	const raw = headers.get("retry-after") ?? headers.get("Retry-After");
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return seconds * 1000;
	const date = Date.parse(raw);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	return undefined;
}
function getErrorStatus(error) {
	if (error instanceof CodexHttpError) return error.status;
	if (!error || typeof error !== "object") return undefined;
	const record = error;
	const status = record.status;
	if (typeof status === "number") return status;
	if (typeof status === "string" && status.trim()) {
		const parsed = Number(status);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}
function getErrorMessage(error) {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : JSON.stringify(error);
}
function getRetryAfterFromError(error) {
	if (error instanceof CodexHttpError) return error.retryAfterMs;
	if (!error || typeof error !== "object") return undefined;
	const record = error;
	const retryAfter = record.retryAfterMs;
	return typeof retryAfter === "number" ? retryAfter : undefined;
}
function resolveRetryClasses(retryOn) {
	return retryOn && retryOn.length > 0 ? retryOn : DEFAULT_RETRY_CLASSES;
}
function hasRetryClass(classes, value) {
	return classes.includes(value);
}
function isTransportErrorMessage(message) {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("terminated") ||
		normalized.includes("fetch failed") ||
		normalized.includes("network") ||
		normalized.includes("econnreset") ||
		normalized.includes("etimedout") ||
		normalized.includes("econnrefused")
	);
}
const DEFAULT_COOLDOWN_MS = 60_000;
function parseCooldownFromMessage(message) {
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
function classifyCooldown(error) {
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
export function isRetryableCodexError(error, signal, retryOn) {
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
export function getRetryDelay(attempt, baseDelay, maxDelay, error) {
	const backoff = getExponentialBackoff(attempt, baseDelay, maxDelay);
	const retryAfterMs = getRetryAfterFromError(error);
	if (retryAfterMs === undefined) return Math.min(maxDelay, backoff);
	return Math.min(maxDelay, Math.max(backoff, retryAfterMs));
}
function resolveCodexRetryOptions(options) {
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
function isStoredOAuthAccessToken(token) {
	const accounts = listOAuthAccounts("openai-codex");
	return accounts.some((account) => account.credentials.access === token);
}
async function resolveCodexApiKey(modelProvider, explicitKey) {
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
function tryMarkCodexCooldown(apiKey, cooldownMs) {
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
export const streamOpenAICodexResponses = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	(async () => {
		const output = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses",
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
		let lastError;
		let lastApiKey = null;
		let lastApiKeyWasOAuth = false;
		let lastCooldownMarkedKey = null;
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
				if (!response.ok) {
					const info = await parseErrorResponse(response);
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
				await processStream(response, output, stream, model);
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}
				if (output.stopReason === "error" || output.stopReason === "aborted") {
					throw new Error(output.errorMessage || "Codex response failed");
				}
				stream.push({ type: "done", reason: output.stopReason, message: output });
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
function buildRequestBody(model, context, options) {
	const systemPrompt = buildSystemPrompt(context.systemPrompt, context.tools);
	const messages = convertMessages(model, context);
	// Prepend developer messages
	const developerMessages = systemPrompt.developerMessages.map((text) => ({
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text }],
	}));
	const body = {
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
function buildSystemPrompt(userSystemPrompt, tools) {
	if (USE_LEGACY_CODEX_PROMPT) {
		const developerMessages = [];
		const bridgeText = buildCodexMuBridge(tools);
		if (bridgeText.trim()) developerMessages.push(bridgeText.trim());
		if (userSystemPrompt?.trim()) developerMessages.push(userSystemPrompt.trim());
		return { instructions: OPENCODE_CODEX_INSTRUCTIONS, developerMessages };
	}
	const staticPrefix = MU_STATIC_INSTRUCTIONS.trim();
	const staticInstructions = `<system_instructions>\n${staticPrefix}\n</system_instructions>`;
	const developerMessages = [];
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
function clampReasoningEffort(modelId, effort) {
	const id = modelId.includes("/") ? modelId.split("/").pop() : modelId;
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}
// ============================================================================
// Message Conversion
// ============================================================================
function convertMessages(model, context) {
	const messages = [];
	const transformed = transformMessages(context.messages, model);
	for (const msg of transformed) {
		if (msg.role === "user") {
			messages.push(convertUserMessage(msg, model));
		} else if (msg.role === "assistant") {
			messages.push(...convertAssistantMessage(msg));
		} else if (msg.role === "toolResult") {
			messages.push(...convertToolResult(msg, model));
		}
	}
	return messages.filter(Boolean);
}
function convertUserMessage(msg, model) {
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
function convertAssistantMessage(msg) {
	const output = [];
	for (const block of msg.content) {
		if (block.type === "thinking" && msg.stopReason !== "error" && block.thinkingSignature) {
			output.push(JSON.parse(block.thinkingSignature));
		} else if (block.type === "text") {
			output.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
				status: "completed",
			});
		} else if (block.type === "toolCall" && msg.stopReason !== "error") {
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
function convertToolResult(msg, model) {
	const output = [];
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
async function processStream(response, output, stream, model) {
	let currentItem = null;
	let currentBlock = null;
	let sawCompletion = false;
	let hadContent = false;
	const blockIndex = () => output.content.length - 1;
	for await (const event of parseSSE(response)) {
		const type = event.type;
		switch (type) {
			case "response.output_item.added": {
				const item = event.item;
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
					currentBlock = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: {},
						partialJson: item.arguments || "",
					};
					output.content.push(currentBlock);
					stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
				}
				break;
			}
			case "response.reasoning_summary_part.added": {
				if (currentItem?.type === "reasoning") {
					currentItem.summary = currentItem.summary || [];
					currentItem.summary.push(event.part);
				}
				break;
			}
			case "response.reasoning_summary_text.delta": {
				if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
					const delta = event.delta || "";
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
					const part = event.part;
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
						const delta = event.delta || "";
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
						const delta = event.delta || "";
						currentBlock.text += delta;
						lastPart.refusal += delta;
						stream.push({ type: "text_delta", contentIndex: blockIndex(), delta, partial: output });
					}
				}
				break;
			}
			case "response.function_call_arguments.delta": {
				if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
					const delta = event.delta || "";
					currentBlock.partialJson += delta;
					currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
					stream.push({ type: "toolcall_delta", contentIndex: blockIndex(), delta, partial: output });
				}
				break;
			}
			case "response.function_call_arguments.done": {
				if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
					const args = event.arguments || "";
					currentBlock.partialJson = args;
					currentBlock.arguments = parseStreamingJson(args);
				}
				break;
			}
			case "response.output_item.done": {
				const item = event.item;
				if (item.type === "reasoning" && currentBlock?.type === "thinking") {
					currentBlock.thinking = item.summary?.map((s) => s.text).join("\n\n") || "";
					currentBlock.thinkingSignature = JSON.stringify(item);
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
					currentBlock = null;
				} else if (item.type === "message" && currentBlock?.type === "text") {
					currentBlock.text = item.content.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("");
					currentBlock.textSignature = item.id;
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
					currentBlock = null;
				} else if (item.type === "function_call") {
					// Use accumulated partialJson as fallback if item.arguments is empty/missing
					const argsStr =
						item.arguments || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "{}") || "{}";
					const toolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: JSON.parse(argsStr),
					};
					stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
				}
				break;
			}
			case "response.completed":
			case "response.done": {
				sawCompletion = true;
				const resp = event.response;
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
				if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
					output.stopReason = "toolUse";
				}
				break;
			}
			case "error": {
				const code = event.code || "";
				const message = event.message || "";
				throw new Error(formatCodexErrorEvent(event, code, message));
			}
			case "response.failed": {
				throw new Error(formatCodexFailure(event) ?? "Codex response failed");
			}
		}
	}
	if (!sawCompletion) {
		throw new CodexStreamError("Stream terminated", hadContent);
	}
}
// ============================================================================
// Headers
// ============================================================================
function buildHeaders(initHeaders, accountId, accessToken, promptCacheKey) {
	const headers = new Headers(initHeaders ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set("OpenAI-Organization", accountId);
	headers.set("OpenAI-Beta", "responses=codex");
	headers.set("OpenAI-Organization-Context", "codex");
	headers.set("User-Agent", `pi (${os.platform()} ${os.release()}; ${os.arch()})`);
	if (promptCacheKey) {
		headers.set("OpenAI-Conversation-ID", promptCacheKey);
		headers.set("OpenAI-Session-ID", promptCacheKey);
	} else {
		headers.delete("OpenAI-Conversation-ID");
		headers.delete("OpenAI-Session-ID");
	}
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	return headers;
}
// ============================================================================
// JSON Parsing
// ============================================================================
function parseSSE(response) {
	const decoder = new TextDecoder();
	let buffer = "";
	if (!response.body) return (async function* () {})();
	const reader = response.body.getReader();
	const parseChunk = (chunk) => {
		if (!chunk.trim()) return { done: false };
		const dataLines = chunk
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim());
		if (dataLines.length === 0) return { done: false };
		const data = dataLines.join("\n");
		if (data === "[DONE]") return { done: true };
		try {
			const json = JSON.parse(data);
			return { done: false, event: json };
		} catch (error) {
			console.warn("Failed to parse SSE JSON:", error);
			return { done: false };
		}
	};
	async function* generator() {
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
// ============================================================================
// Error Handling
// ============================================================================
async function parseErrorResponse(response) {
	const contentType = response.headers.get("content-type") || "";
	let bodyText = "";
	try {
		bodyText = await response.text();
	} catch {
		bodyText = "";
	}
	if (contentType.includes("application/json") && bodyText) {
		try {
			const json = JSON.parse(bodyText);
			const error = json.error;
			return {
				message: error?.message || bodyText,
				friendlyMessage: error?.details || undefined,
			};
		} catch {
			return { message: bodyText };
		}
	}
	return { message: bodyText || `Request failed with status ${response.status}` };
}
function formatCodexErrorEvent(event, code, message) {
	return `Codex error (${code}): ${message || JSON.stringify(event)}`;
}
function formatCodexFailure(rawEvent) {
	const response = asRecord(rawEvent.response);
	const error = asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);
	const message = getString(error?.message) ?? getString(rawEvent.message) ?? getString(response?.message);
	const code = getString(error?.code) ?? getString(error?.type) ?? getString(rawEvent.code);
	if (!message && !code) return null;
	return code ? `Codex response failed (${code}): ${message || "Unknown error"}` : `Codex response failed: ${message}`;
}
function asRecord(value) {
	if (value && typeof value === "object") {
		return value;
	}
	return null;
}
function getString(value) {
	return typeof value === "string" ? value : undefined;
}
// ============================================================================
// Stop Reason Mapping
// ============================================================================
function mapStopReason(status) {
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
function decodeJwt(token) {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = Buffer.from(payload, "base64").toString("utf-8");
		return JSON.parse(decoded);
	} catch {
		return null;
	}
}
function extractAccountId(accessToken) {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}
	return accountId;
}
//# sourceMappingURL=openai-codex-responses.js.map
