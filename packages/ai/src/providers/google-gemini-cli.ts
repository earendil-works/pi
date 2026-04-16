/**
 * Google Gemini CLI / Antigravity provider.
 * Shared implementation for both google-gemini-cli and google-antigravity providers.
 * Uses the Cloud Code Assist API endpoint to access Gemini and Claude models.
 */

import type { Content, ThinkingConfig } from "@google/genai";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReasonString,
	mapToolChoice,
	retainThoughtSignature,
} from "./google-shared.js";
import { buildBaseOptions, clampReasoning } from "./simple-options.js";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface GoogleGeminiCliOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	/**
	 * Thinking/reasoning configuration.
	 * - Gemini 2.x models: use `budgetTokens` to set the thinking budget
	 * - Gemini 3 models (gemini-3-pro-*, gemini-3-flash-*): use `level` instead
	 *
	 * When using `streamSimple`, this is handled automatically based on the model.
	 */
	thinking?: {
		enabled: boolean;
		/** Thinking budget in tokens. Use for Gemini 2.x models. */
		budgetTokens?: number;
		/** Thinking level. Use for Gemini 3 models (LOW/HIGH for Pro, MINIMAL/LOW/MEDIUM/HIGH for Flash). */
		level?: GoogleThinkingLevel;
	};
	projectId?: string;
}

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_AUTOPUSH_ENDPOINT = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
	ANTIGRAVITY_DAILY_ENDPOINT,
	ANTIGRAVITY_AUTOPUSH_ENDPOINT,
	DEFAULT_ENDPOINT,
] as const;
// Headers for Gemini CLI (prod endpoint)
const GEMINI_CLI_HEADERS = {
	"User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
	"Client-Metadata": JSON.stringify({
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	}),
};

// Headers for Antigravity (sandbox endpoint) - requires specific User-Agent
const DEFAULT_ANTIGRAVITY_VERSION = "1.21.9";

function getAntigravityHeaders() {
	const version = process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION;
	return {
		"User-Agent": `antigravity/${version} darwin/arm64`,
	};
}

// Antigravity system instruction (compact version from CLIProxyAPI).
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";

/**
 * Extract retry delay from Gemini error response (in milliseconds).
 * Checks headers first (Retry-After, x-ratelimit-reset, x-ratelimit-reset-after),
 * then parses body patterns like:
 * - "Your quota will reset after 39s"
 * - "Your quota will reset after 18h31m10s"
 * - "Please retry in Xs" or "Please retry in Xms"
 * - "retryDelay": "34.074824224s" (JSON field)
 */
export function extractRetryDelay(errorText: string, response?: Response | Headers): number | undefined {
	const normalizeDelay = (ms: number): number | undefined => (ms > 0 ? Math.ceil(ms + 1000) : undefined);

	const headers = response instanceof Headers ? response : response?.headers;
	if (headers) {
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const retryAfterSeconds = Number(retryAfter);
			if (Number.isFinite(retryAfterSeconds)) {
				const delay = normalizeDelay(retryAfterSeconds * 1000);
				if (delay !== undefined) {
					return delay;
				}
			}
			const retryAfterDate = new Date(retryAfter);
			const retryAfterMs = retryAfterDate.getTime();
			if (!Number.isNaN(retryAfterMs)) {
				const delay = normalizeDelay(retryAfterMs - Date.now());
				if (delay !== undefined) {
					return delay;
				}
			}
		}

		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			if (!Number.isNaN(resetSeconds)) {
				const delay = normalizeDelay(resetSeconds * 1000 - Date.now());
				if (delay !== undefined) {
					return delay;
				}
			}
		}

		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const resetAfterSeconds = Number(rateLimitResetAfter);
			if (Number.isFinite(resetAfterSeconds)) {
				const delay = normalizeDelay(resetAfterSeconds * 1000);
				if (delay !== undefined) {
					return delay;
				}
			}
		}
	}

	// Pattern 1: "Your quota will reset after ..." (formats: "18h31m10s", "10m15s", "6s", "39s")
	const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (durationMatch) {
		const hours = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
		const minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
		const seconds = parseFloat(durationMatch[3]);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			const delay = normalizeDelay(totalMs);
			if (delay !== undefined) {
				return delay;
			}
		}
	}

	// Pattern 2: "Please retry in X[ms|s]"
	const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1]) {
		const value = parseFloat(retryInMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) {
				return delay;
			}
		}
	}

	// Pattern 3: "retryDelay": "34.074824224s" (JSON field in error details)
	const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
	if (retryDelayMatch?.[1]) {
		const value = parseFloat(retryDelayMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) {
				return delay;
			}
		}
	}

	return undefined;
}

function needsClaudeThinkingBetaHeader(model: Model<"google-gemini-cli">): boolean {
	return model.provider === "google-antigravity" && model.id.startsWith("claude-") && model.reasoning;
}

function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.1)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string): boolean {
	return /gemini-3(?:\.1)?-flash/.test(modelId.toLowerCase());
}

function isGemini3Model(modelId: string): boolean {
	return isGemini3ProModel(modelId) || isGemini3FlashModel(modelId);
}

/**
 * Check if an error is retryable (rate limit, server error, network error, etc.)
 */
function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(errorText);
}

/**
 * Extract a clean, user-friendly error message from Google API error response.
 * Parses JSON error responses and returns just the message field.
 */
function extractErrorMessage(errorText: string): string {
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) {
			return parsed.error.message;
		}
	} catch {
		// Not JSON, return as-is
	}
	return errorText;
}

/**
 * Sleep for a given number of milliseconds, respecting abort signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: ReturnType<typeof convertTools>;
		toolConfig?: {
			functionCallingConfig: {
				mode: ReturnType<typeof mapToolChoice>;
			};
		};
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

interface CloudCodeAssistResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					thought?: boolean;
					thoughtSignature?: string;
					functionCall?: {
						name: string;
						args: Record<string, unknown>;
						id?: string;
					};
				}>;
			};
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		modelVersion?: string;
		responseId?: string;
	};
	traceId?: string;
}

export const streamGoogleGeminiCli: StreamFunction<"google-gemini-cli", GoogleGeminiCliOptions> = (
	model: Model<"google-gemini-cli">,
	context: Context,
	options?: GoogleGeminiCliOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-gemini-cli" as Api,
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

		try {
			// apiKey is JSON-encoded: { token, projectId }
			const apiKeyRaw = options?.apiKey;
			if (!apiKeyRaw) {
				throw new Error("Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.");
			}

			let accessToken: string;
			let projectId: string;

			try {
				const parsed = JSON.parse(apiKeyRaw) as { token: string; projectId: string };
				accessToken = parsed.token;
				projectId = parsed.projectId;
			} catch {
				throw new Error("Invalid Google Cloud Code Assist credentials. Use /login to re-authenticate.");
			}

			if (!accessToken || !projectId) {
				throw new Error("Missing token or projectId in Google Cloud credentials. Use /login to re-authenticate.");
			}

			const isAntigravity = model.provider === "google-antigravity";
			const baseUrl = model.baseUrl?.trim();
			const endpoints = baseUrl ? [baseUrl] : isAntigravity ? ANTIGRAVITY_ENDPOINT_FALLBACKS : [DEFAULT_ENDPOINT];

			let requestBody = buildRequest(model, context, projectId, options, isAntigravity);
			const nextRequestBody = await options?.onPayload?.(requestBody, model);
			if (nextRequestBody !== undefined) {
				requestBody = nextRequestBody as CloudCodeAssistRequest;
			}
			const headers = isAntigravity ? getAntigravityHeaders() : GEMINI_CLI_HEADERS;

			const requestHeaders = {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...headers,
				...(needsClaudeThinkingBetaHeader(model) ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER } : {}),
				...options?.headers,
			};
			const requestBodyJson = JSON.stringify(requestBody);

			// Fetch with retry logic for rate limits, transient errors, and endpoint fallbacks.
			// On 403/404, immediately try the next endpoint (no delay).
			// On 429/5xx, retry with backoff on the same or next endpoint.
			let response: Response | undefined;
			let lastError: Error | undefined;
			let requestUrl: string | undefined;
			let endpointIndex = 0;

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					const endpoint = endpoints[endpointIndex];
					requestUrl = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
					response = await fetch(requestUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);

					if (response.ok) {
						break; // Success, exit retry loop
					}

					const errorText = await response.text();

					// On 403/404, cascade to the next endpoint immediately (no delay)
					if ((response.status === 403 || response.status === 404) && endpointIndex < endpoints.length - 1) {
						endpointIndex++;
						continue;
					}

					// Check if retryable (429, 5xx, network patterns)
					if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
						// Advance endpoint if possible
						if (endpointIndex < endpoints.length - 1) {
							endpointIndex++;
						}

						// Use server-provided delay or exponential backoff
						const serverDelay = extractRetryDelay(errorText, response);
						const delayMs = serverDelay ?? BASE_DELAY_MS * 2 ** attempt;

						// Check if server delay exceeds max allowed (default: 60s)
						const maxDelayMs = options?.maxRetryDelayMs ?? 60000;
						if (maxDelayMs > 0 && serverDelay && serverDelay > maxDelayMs) {
							const delaySeconds = Math.ceil(serverDelay / 1000);
							throw new Error(
								`Server requested ${delaySeconds}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${extractErrorMessage(errorText)}`,
							);
						}

						await sleep(delayMs, options?.signal);
						continue;
					}

					// Not retryable or max retries exceeded
					throw new Error(`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`);
				} catch (error) {
					// Check for abort - fetch throws AbortError, our code throws "Request was aborted"
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}
					// Extract detailed error message from fetch errors (Node includes cause)
					lastError = error instanceof Error ? error : new Error(String(error));
					if (lastError.message === "fetch failed" && lastError.cause instanceof Error) {
						lastError = new Error(`Network error: ${lastError.cause.message}`);
					}
					// Network errors are retryable
					if (attempt < MAX_RETRIES) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response || !response.ok) {
				throw lastError ?? new Error("Failed to get response after retries");
			}

			let started = false;
			const ensureStarted = () => {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}
			};

			const resetOutput = () => {
				output.content = [];
				output.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				output.stopReason = "stop";
				output.errorMessage = undefined;
				output.timestamp = Date.now();
				started = false;
			};

			const streamResponse = async (activeResponse: Response): Promise<boolean> => {
				if (!activeResponse.body) {
					throw new Error("No response body");
				}

				let hasContent = false;
				let currentBlock: TextContent | ThinkingContent | null = null;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;

				// Read SSE stream
				const reader = activeResponse.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				// Set up abort handler to cancel reader when signal fires
				const abortHandler = () => {
					void reader.cancel().catch(() => {});
				};
				options?.signal?.addEventListener("abort", abortHandler);

				try {
					while (true) {
						// Check abort signal before each read
						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}

						const { done, value } = await reader.read();
						if (done) break;

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";

						for (const line of lines) {
							if (!line.startsWith("data:")) continue;

							const jsonStr = line.slice(5).trim();
							if (!jsonStr) continue;

							let chunk: CloudCodeAssistResponseChunk;
							try {
								chunk = JSON.parse(jsonStr);
							} catch {
								continue;
							}

							// Unwrap the response
							const responseData = chunk.response;
							if (!responseData) continue;
							// Cloud Code Assist mirrors Gemini's responseId field. Keep the first non-empty one.
							// A single streamed response should retain the same ID across chunks.
							output.responseId ||= responseData.responseId;

							const candidate = responseData.candidates?.[0];
							if (candidate?.content?.parts) {
								for (const part of candidate.content.parts) {
									if (part.text !== undefined) {
										hasContent = true;
										const isThinking = isThinkingPart(part);
										if (
											!currentBlock ||
											(isThinking && currentBlock.type !== "thinking") ||
											(!isThinking && currentBlock.type !== "text")
										) {
											if (currentBlock) {
												if (currentBlock.type === "text") {
													stream.push({
														type: "text_end",
														contentIndex: blocks.length - 1,
														content: currentBlock.text,
														partial: output,
													});
												} else {
													stream.push({
														type: "thinking_end",
														contentIndex: blockIndex(),
														content: currentBlock.thinking,
														partial: output,
													});
												}
											}
											if (isThinking) {
												currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
												output.content.push(currentBlock);
												ensureStarted();
												stream.push({
													type: "thinking_start",
													contentIndex: blockIndex(),
													partial: output,
												});
											} else {
												currentBlock = { type: "text", text: "" };
												output.content.push(currentBlock);
												ensureStarted();
												stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
											}
										}
										if (currentBlock.type === "thinking") {
											currentBlock.thinking += part.text;
											currentBlock.thinkingSignature = retainThoughtSignature(
												currentBlock.thinkingSignature,
												part.thoughtSignature,
											);
											stream.push({
												type: "thinking_delta",
												contentIndex: blockIndex(),
												delta: part.text,
												partial: output,
											});
										} else {
											currentBlock.text += part.text;
											currentBlock.textSignature = retainThoughtSignature(
												currentBlock.textSignature,
												part.thoughtSignature,
											);
											stream.push({
												type: "text_delta",
												contentIndex: blockIndex(),
												delta: part.text,
												partial: output,
											});
										}
									}

									if (part.functionCall) {
										hasContent = true;
										if (currentBlock) {
											if (currentBlock.type === "text") {
												stream.push({
													type: "text_end",
													contentIndex: blockIndex(),
													content: currentBlock.text,
													partial: output,
												});
											} else {
												stream.push({
													type: "thinking_end",
													contentIndex: blockIndex(),
													content: currentBlock.thinking,
													partial: output,
												});
											}
											currentBlock = null;
										}

										const providedId = part.functionCall.id;
										const needsNewId =
											!providedId ||
											output.content.some((b) => b.type === "toolCall" && b.id === providedId);
										const toolCallId = needsNewId
											? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
											: providedId;

										const toolCall: ToolCall = {
											type: "toolCall",
											id: toolCallId,
											name: part.functionCall.name || "",
											arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
											...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
										};

										output.content.push(toolCall);
										ensureStarted();
										stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
										stream.push({
											type: "toolcall_delta",
											contentIndex: blockIndex(),
											delta: JSON.stringify(toolCall.arguments),
											partial: output,
										});
										stream.push({
											type: "toolcall_end",
											contentIndex: blockIndex(),
											toolCall,
											partial: output,
										});
									}
								}
							}

							if (candidate?.finishReason) {
								output.stopReason = mapStopReasonString(candidate.finishReason);
								if (output.content.some((b) => b.type === "toolCall")) {
									output.stopReason = "toolUse";
								}
							}

							if (responseData.usageMetadata) {
								// promptTokenCount includes cachedContentTokenCount, so subtract to get fresh input
								const promptTokens = responseData.usageMetadata.promptTokenCount || 0;
								const cacheReadTokens = responseData.usageMetadata.cachedContentTokenCount || 0;
								output.usage = {
									input: promptTokens - cacheReadTokens,
									output:
										(responseData.usageMetadata.candidatesTokenCount || 0) +
										(responseData.usageMetadata.thoughtsTokenCount || 0),
									cacheRead: cacheReadTokens,
									cacheWrite: 0,
									totalTokens: responseData.usageMetadata.totalTokenCount || 0,
									cost: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										total: 0,
									},
								};
								calculateCost(model, output.usage);
							}
						}
					}
				} finally {
					options?.signal?.removeEventListener("abort", abortHandler);
				}

				if (currentBlock) {
					if (currentBlock.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: blockIndex(),
							content: currentBlock.text,
							partial: output,
						});
					} else {
						stream.push({
							type: "thinking_end",
							contentIndex: blockIndex(),
							content: currentBlock.thinking,
							partial: output,
						});
					}
				}

				return hasContent;
			};

			let receivedContent = false;
			let currentResponse = response;

			for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				if (emptyAttempt > 0) {
					const backoffMs = EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1);
					await sleep(backoffMs, options?.signal);

					if (!requestUrl) {
						throw new Error("Missing request URL");
					}

					currentResponse = await fetch(requestUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});
					await options?.onResponse?.(
						{ status: currentResponse.status, headers: headersToRecord(currentResponse.headers) },
						model,
					);

					if (!currentResponse.ok) {
						const retryErrorText = await currentResponse.text();
						throw new Error(`Cloud Code Assist API error (${currentResponse.status}): ${retryErrorText}`);
					}
				}

				const streamed = await streamResponse(currentResponse);
				if (streamed) {
					receivedContent = true;
					break;
				}

				if (emptyAttempt < MAX_EMPTY_STREAM_RETRIES) {
					resetOutput();
				}
			}

			if (!receivedContent) {
				throw new Error("Cloud Code Assist API returned an empty response");
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleGoogleGeminiCli: StreamFunction<"google-gemini-cli", SimpleStreamOptions> = (
	model: Model<"google-gemini-cli">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error("Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.");
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamGoogleGeminiCli(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleGeminiCliOptions);
	}

	const effort = clampReasoning(options.reasoning)!;
	if (isGemini3Model(model.id)) {
		return streamGoogleGeminiCli(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getGeminiCliThinkingLevel(effort, model.id),
			},
		} satisfies GoogleGeminiCliOptions);
	}

	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...options.thinkingBudgets };

	const minOutputTokens = 1024;
	let thinkingBudget = budgets[effort]!;
	const maxTokens = Math.min((base.maxTokens || 0) + thinkingBudget, model.maxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return streamGoogleGeminiCli(model, context, {
		...base,
		maxTokens,
		thinking: {
			enabled: true,
			budgetTokens: thinkingBudget,
		},
	} satisfies GoogleGeminiCliOptions);
};

export function buildRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
	isAntigravity = false,
): CloudCodeAssistRequest {
	const contents = convertMessages(model, context);

	const generationConfig: CloudCodeAssistRequest["request"]["generationConfig"] = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	// Thinking config
	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = {
			includeThoughts: true,
		};
		// Gemini 3 models use thinkingLevel, older models use thinkingBudget
		if (options.thinking.level !== undefined) {
			// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level as any;
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		generationConfig.thinkingConfig = getDisabledThinkingConfig(model.id);
	}

	const request: CloudCodeAssistRequest["request"] = {
		contents,
	};

	request.sessionId = options.sessionId;

	// System instruction must be object with parts, not plain string
	if (context.systemPrompt) {
		request.systemInstruction = {
			parts: [{ text: sanitizeSurrogates(context.systemPrompt) }],
		};
	}

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	if (context.tools && context.tools.length > 0) {
		// Claude models on Cloud Code Assist need the legacy `parameters` field;
		// the API translates it into Anthropic's `input_schema`.
		const useParameters = model.id.startsWith("claude-");
		request.tools = convertTools(context.tools, useParameters);
		if (options.toolChoice) {
			request.toolConfig = {
				functionCallingConfig: {
					mode: mapToolChoice(options.toolChoice),
				},
			};
		}
	}

	if (isAntigravity) {
		const existingParts = request.systemInstruction?.parts ?? [];
		request.systemInstruction = {
			role: "user",
			parts: [
				{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
				{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
				...existingParts,
			],
		};
	}

	return {
		project: projectId,
		model: model.id,
		request,
		...(isAntigravity ? { requestType: "agent" } : {}),
		userAgent: isAntigravity ? "antigravity" : "pi-coding-agent",
		requestId: `${isAntigravity ? "agent" : "pi"}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
}

type ClampedThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

function getDisabledThinkingConfig(modelId: string): ThinkingConfig {
	// Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
	// do not support full thinking-off either. For Gemini 3 models, use the lowest supported
	// thinkingLevel without includeThoughts so hidden thinking remains invisible to pi.
	if (isGemini3ProModel(modelId)) {
		return { thinkingLevel: "LOW" as any };
	}
	if (isGemini3FlashModel(modelId)) {
		return { thinkingLevel: "MINIMAL" as any };
	}

	// Gemini 2.x supports disabling via thinkingBudget = 0.
	return { thinkingBudget: 0 };
}

function getGeminiCliThinkingLevel(effort: ClampedThinkingLevel, modelId: string): GoogleThinkingLevel {
	if (isGemini3ProModel(modelId)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}
