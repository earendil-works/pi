/**
 * Google Gemini CLI / Antigravity provider.
 * Shared implementation for both google-gemini-cli and google-antigravity providers.
 * Uses the Cloud Code Assist API endpoint to access Gemini and Claude models.
 */

import type {
	Content,
	GenerationConfigRoutingConfig,
	MediaResolution,
	ModelSelectionConfig,
	SafetySetting,
	SpeechConfigUnion,
	ThinkingConfig,
} from "@google/genai";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { getExponentialBackoff, parseGeminiRetryAfter, sleep } from "../utils/retry.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { convertMessages, convertTools, mapStopReasonString, mapToolChoice } from "./google-shared.js";

export interface GoogleGeminiCliOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	userPromptId?: string;
	sessionId?: string;
	cachedContent?: string;
	labels?: Record<string, string>;
	safetySettings?: SafetySetting[];
	generationConfig?: VertexGenerationConfig;
	/**
	 * Thinking/reasoning configuration.
	 * Uses `budgetTokens` to set the thinking budget.
	 * For Gemini 3 models, this controls thinking intensity.
	 */
	thinking?: {
		enabled: boolean;
		/** Thinking budget in tokens. */
		budgetTokens?: number;
	};
	projectId?: string;
}

interface VertexGenerationConfig {
	temperature?: number;
	topP?: number;
	topK?: number;
	candidateCount?: number;
	maxOutputTokens?: number;
	stopSequences?: string[];
	responseLogprobs?: boolean;
	logprobs?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	seed?: number;
	responseMimeType?: string;
	responseJsonSchema?: unknown;
	responseSchema?: unknown;
	routingConfig?: GenerationConfigRoutingConfig;
	modelSelectionConfig?: ModelSelectionConfig;
	responseModalities?: string[];
	mediaResolution?: MediaResolution;
	speechConfig?: SpeechConfigUnion;
	audioTimestamp?: boolean;
	thinkingConfig?: ThinkingConfig;
}

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
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
const ANTIGRAVITY_HEADERS = {
	"User-Agent": "antigravity/1.11.5 darwin/arm64",
	"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"Client-Metadata": JSON.stringify({
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	}),
};

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	user_prompt_id: string;
	request: {
		contents: Content[];
		systemInstruction?: Content;
		cachedContent?: string;
		tools?: ReturnType<typeof convertTools>;
		toolConfig?: {
			functionCallingConfig: {
				mode: ReturnType<typeof mapToolChoice>;
			};
		};
		labels?: Record<string, string>;
		safetySettings?: SafetySetting[];
		generationConfig?: VertexGenerationConfig;
		session_id?: string;
	};
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

export const streamGoogleGeminiCli: StreamFunction<"google-gemini-cli"> = (
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

			const requestBody = buildRequest(model, context, projectId, options);
			const endpoint = model.baseUrl || DEFAULT_ENDPOINT;
			const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

			// Use Antigravity headers for sandbox endpoint, otherwise Gemini CLI headers
			const isAntigravity = endpoint.includes("sandbox.googleapis.com");
			const headers = isAntigravity ? ANTIGRAVITY_HEADERS : GEMINI_CLI_HEADERS;

			let response: Response | undefined;
			const maxRetries = options?.retry?.maxRetries ?? 3;
			const baseDelay = options?.retry?.baseDelay ?? 1000;
			const maxDelay = options?.retry?.maxDelay ?? 60000;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				try {
					response = await fetch(url, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${accessToken}`,
							"Content-Type": "application/json",
							...headers,
						},
						body: JSON.stringify(requestBody),
						signal: options?.signal,
					});

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					const isRetryable = response.status === 429 || (response.status >= 500 && response.status <= 504);

					if (isRetryable && attempt < maxRetries) {
						// Check for Retry-After header or parse Gemini reset hint
						const retryAfterHeader = response.headers.get("Retry-After");
						const parsedHint = parseGeminiRetryAfter(errorText);
						const backoffDelay = getExponentialBackoff(attempt, baseDelay, maxDelay);

						let delay = backoffDelay;
						if (retryAfterHeader) {
							const seconds = parseInt(retryAfterHeader, 10);
							if (!Number.isNaN(seconds)) delay = Math.max(delay, seconds * 1000);
						}
						if (parsedHint) {
							delay = Math.max(delay, parsedHint);
						}

						// Cap the delay to maxDelay
						delay = Math.min(delay, maxDelay);

						await sleep(delay, options?.signal);
						continue;
					}

					throw new Error(`Cloud Code Assist API error (${response.status}): ${errorText}`);
				} catch (error) {
					// If it's a network error (not a Response error) and we have retries left, retry
					const isAborted = error instanceof Error && (error.name === "AbortError" || error.message === "Aborted");
					const isNetworkError = error instanceof Error && !error.message.includes("Cloud Code Assist API error");

					if (isNetworkError && !isAborted && attempt < maxRetries) {
						await sleep(getExponentialBackoff(attempt, baseDelay, maxDelay), options?.signal);
						continue;
					}
					throw error;
				}
			}

			if (!response) {
				throw new Error("Failed to connect to Cloud Code Assist API");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });

			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;

			// Read SSE stream
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
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

					const candidate = responseData.candidates?.[0];
					if (candidate?.content?.parts) {
						for (const part of candidate.content.parts) {
							if (part.text !== undefined) {
								const isThinking = part.thought === true;
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
										stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
									} else {
										currentBlock = { type: "text", text: "" };
										output.content.push(currentBlock);
										stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
									}
								}
								if (currentBlock.type === "thinking") {
									currentBlock.thinking += part.text;
									currentBlock.thinkingSignature = part.thoughtSignature;
									stream.push({
										type: "thinking_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								} else {
									currentBlock.text += part.text;
									stream.push({
										type: "text_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								}
							}

							if (part.functionCall) {
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
									!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
								const toolCallId = needsNewId
									? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
									: providedId;

								const toolCall: ToolCall = {
									type: "toolCall",
									id: toolCallId,
									name: part.functionCall.name || "",
									arguments: part.functionCall.args as Record<string, unknown>,
									...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
								};

								output.content.push(toolCall);
								stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta: JSON.stringify(toolCall.arguments),
									partial: output,
								});
								stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
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

function buildRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
): CloudCodeAssistRequest {
	const contents = convertMessages(model, context);

	const generationConfig: VertexGenerationConfig = {
		...(options.generationConfig ?? {}),
	};
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
		// Use budgetTokens for thinking budget
		if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	}

	const request: CloudCodeAssistRequest["request"] = {
		contents,
	};

	// System instruction must be object with parts, not plain string
	if (context.systemPrompt) {
		request.systemInstruction = {
			role: "user",
			parts: [{ text: sanitizeSurrogates(context.systemPrompt) }],
		};
	}

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	if (context.tools && context.tools.length > 0) {
		request.tools = convertTools(context.tools);
		if (options.toolChoice) {
			request.toolConfig = {
				functionCallingConfig: {
					mode: mapToolChoice(options.toolChoice),
				},
			};
		}
	}

	if (options.cachedContent !== undefined) {
		request.cachedContent = options.cachedContent;
	}

	if (options.labels !== undefined) {
		request.labels = options.labels;
	}

	if (options.safetySettings !== undefined) {
		request.safetySettings = options.safetySettings;
	}

	if (options.sessionId !== undefined) {
		request.session_id = options.sessionId;
	}

	const userPromptId = options.userPromptId ?? `mu-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

	return {
		project: projectId,
		model: model.id,
		user_prompt_id: userPromptId,
		request,
	};
}
