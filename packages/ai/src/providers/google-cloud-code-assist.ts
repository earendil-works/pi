/**
 * Google Cloud Code Assist provider for Gemini CLI / Antigravity authentication.
 * Uses the Cloud Code Assist API endpoint to access Gemini and Claude models.
 */

import type { Content, ThinkingConfig } from "@google/genai";
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
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { convertMessages, convertTools, mapStopReasonString, mapToolChoice } from "./google-shared.js";

export interface GoogleCloudCodeAssistOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
	};
	projectId?: string;
}

const ENDPOINT = "https://cloudcode-pa.googleapis.com";
const HEADERS = {
	"User-Agent": "google-api-nodejs-client/9.15.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		systemInstruction?: { parts: { text: string }[] };
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

export const streamGoogleCloudCodeAssist: StreamFunction<"google-cloud-code-assist"> = (
	model: Model<"google-cloud-code-assist">,
	context: Context,
	options?: GoogleCloudCodeAssistOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-cloud-code-assist" as Api,
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
			const url = `${ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;

			const response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					...HEADERS,
				},
				body: JSON.stringify(requestBody),
				signal: options?.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Cloud Code Assist API error (${response.status}): ${errorText}`);
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
						output.usage = {
							input: responseData.usageMetadata.promptTokenCount || 0,
							output:
								(responseData.usageMetadata.candidatesTokenCount || 0) +
								(responseData.usageMetadata.thoughtsTokenCount || 0),
							cacheRead: responseData.usageMetadata.cachedContentTokenCount || 0,
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
	model: Model<"google-cloud-code-assist">,
	context: Context,
	projectId: string,
	options: GoogleCloudCodeAssistOptions = {},
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

	return {
		project: projectId,
		model: model.id,
		request,
		userAgent: "pi-coding-agent",
		requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
}
