import Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { calculateCost } from "../models.js";
import { getEnvApiKey } from "../stream.js";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { getExponentialBackoff, sleep } from "../utils/retry.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transorm-messages.js";

const claudeCodeVersion = "2.1.2";

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export interface AnthropicOptions extends StreamOptions {
	thinkingEnabled?: boolean;
	thinkingBudgetTokens?: number;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}

function parseErrorJson(message: string): Record<string, unknown> | null {
	const start = message.indexOf("{");
	const end = message.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	const candidate = message.slice(start, end + 1);
	try {
		return asRecord(JSON.parse(candidate));
	} catch {
		return null;
	}
}

function getErrorType(error: unknown): string | undefined {
	const record = asRecord(error);
	const nestedError = record ? asRecord(record.error) : null;
	const nestedType = nestedError && typeof nestedError.type === "string" ? nestedError.type : undefined;
	if (nestedType) return nestedType;

	const rootType = record && typeof record.type === "string" ? record.type : undefined;
	if (rootType) return rootType;

	if (error instanceof Error) {
		const parsed = parseErrorJson(error.message);
		if (parsed) {
			const parsedError = asRecord(parsed.error);
			const parsedType = parsedError && typeof parsedError.type === "string" ? parsedError.type : undefined;
			return parsedType ?? (typeof parsed.type === "string" ? parsed.type : undefined);
		}
	}

	return undefined;
}

function getStatusCode(error: unknown): number | undefined {
	const record = asRecord(error);
	return toNumber(record?.status);
}

/**
 * Check if error is retryable. Never retries when aborted.
 * Retries: overloaded_error, rate_limit_error, 5xx, network errors.
 */
function isRetryableError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return false;

	const errorType = getErrorType(error);
	if (errorType === "overloaded_error" || errorType === "rate_limit_error") {
		return true;
	}

	const statusCode = getStatusCode(error);
	if (statusCode !== undefined && statusCode >= 500 && statusCode <= 504) {
		return true;
	}

	if (error instanceof Error) {
		const message = error.message.toLowerCase();
		if (
			message.includes("etimedout") ||
			message.includes("econnreset") ||
			message.includes("econnrefused") ||
			message.includes("network")
		) {
			return true;
		}
	}

	return false;
}

export const streamAnthropic: StreamFunction<"anthropic-messages"> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const maxRetries = options?.retry?.maxRetries ?? 9;
		const baseDelay = options?.retry?.baseDelay ?? 100;
		const maxDelay = options?.retry?.maxDelay ?? 60000;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages" as Api,
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

		let lastError: unknown;
		let hasEmittedStart = false;
		let attempts = 0;

		// Retry window = before first event emission (prevents duplicate start events)
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			attempts = attempt + 1;
			try {
				output.content = [];

				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
				const { client, isOAuthToken } = createClient(model, apiKey, options?.interleavedThinking ?? true);
				const params = buildParams(model, context, isOAuthToken, options);
				const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: options?.signal });

				type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
				const blocks = output.content as Block[];

				// Must get first event before emitting start (retry boundary)
				const iterator = anthropicStream[Symbol.asyncIterator]();
				const firstResult = await iterator.next();

				if (firstResult.done) {
					throw new Error("Stream ended without events");
				}

				if (!hasEmittedStart) {
					hasEmittedStart = true;
					stream.push({ type: "start", partial: output });
				}

				let event = firstResult.value;
				let hasMoreEvents = true;

				while (hasMoreEvents) {
					if (event.type === "message_start") {
						// Capture early for partial results (e.g., if aborted before completion)
						output.usage.input = event.message.usage.input_tokens || 0;
						output.usage.output = event.message.usage.output_tokens || 0;
						output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
						output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
					} else if (event.type === "content_block_start") {
						if (event.content_block.type === "text") {
							const block: Block = {
								type: "text",
								text: "",
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "thinking") {
							const block: Block = {
								type: "thinking",
								thinking: "",
								thinkingSignature: "",
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "redacted_thinking") {
							// Anthropic withholds some reasoning. Store placeholder + encrypted signature.
							// thinking_end emitted later by content_block_stop handler
							const block: Block = {
								type: "thinking",
								thinking: "[Reasoning redacted by Anthropic]",
								thinkingSignature: `redacted:${event.content_block.data}`,
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "tool_use") {
							const block: Block = {
								type: "toolCall",
								id: event.content_block.id,
								name: event.content_block.name,
								arguments: event.content_block.input as Record<string, any>,
								partialJson: "",
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						}
					} else if (event.type === "content_block_delta") {
						if (event.delta.type === "text_delta") {
							const index = blocks.findIndex((b) => b.index === (event as any).index);
							const block = blocks[index];
							if (block && block.type === "text") {
								block.text += event.delta.text;
								stream.push({
									type: "text_delta",
									contentIndex: index,
									delta: event.delta.text,
									partial: output,
								});
							}
						} else if (event.delta.type === "thinking_delta") {
							const index = blocks.findIndex((b) => b.index === (event as any).index);
							const block = blocks[index];
							if (block && block.type === "thinking") {
								block.thinking += event.delta.thinking;
								stream.push({
									type: "thinking_delta",
									contentIndex: index,
									delta: event.delta.thinking,
									partial: output,
								});
							}
						} else if (event.delta.type === "input_json_delta") {
							const index = blocks.findIndex((b) => b.index === (event as any).index);
							const block = blocks[index];
							if (block && block.type === "toolCall") {
								block.partialJson += event.delta.partial_json;
								block.arguments = parseStreamingJson(block.partialJson);
								stream.push({
									type: "toolcall_delta",
									contentIndex: index,
									delta: event.delta.partial_json,
									partial: output,
								});
							}
						} else if (event.delta.type === "signature_delta") {
							const index = blocks.findIndex((b) => b.index === (event as any).index);
							const block = blocks[index];
							if (block && block.type === "thinking") {
								block.thinkingSignature = block.thinkingSignature || "";
								block.thinkingSignature += event.delta.signature;
							}
						}
					} else if (event.type === "content_block_stop") {
						const index = blocks.findIndex((b) => b.index === (event as any).index);
						const block = blocks[index];
						if (block) {
							delete (block as any).index;
							if (block.type === "text") {
								stream.push({
									type: "text_end",
									contentIndex: index,
									content: block.text,
									partial: output,
								});
							} else if (block.type === "thinking") {
								stream.push({
									type: "thinking_end",
									contentIndex: index,
									content: block.thinking,
									partial: output,
								});
							} else if (block.type === "toolCall") {
								block.arguments = parseStreamingJson(block.partialJson);

								delete (block as any).partialJson;
								stream.push({
									type: "toolcall_end",
									contentIndex: index,
									toolCall: block,
									partial: output,
								});
							}
						}
					} else if (event.type === "message_delta") {
						if (event.delta.stop_reason) {
							output.stopReason = mapStopReason(event.delta.stop_reason);
						}
						output.usage.input = event.usage.input_tokens || 0;
						output.usage.output = event.usage.output_tokens || 0;
						output.usage.cacheRead = event.usage.cache_read_input_tokens || 0;
						output.usage.cacheWrite = event.usage.cache_creation_input_tokens || 0;
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
					}

					const nextResult = await iterator.next();
					if (nextResult.done) {
						hasMoreEvents = false;
					} else {
						event = nextResult.value;
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
				return;
			} catch (error) {
				lastError = error;

				for (const block of output.content) delete (block as any).index;

				const shouldRetry = !hasEmittedStart && isRetryableError(error, options?.signal) && attempt < maxRetries;

				if (shouldRetry) {
					const delay = getExponentialBackoff(attempt, baseDelay, maxDelay);
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

		// Retry loop exhausted or non-retryable error
		if (!hasEmittedStart) {
			stream.push({ type: "start", partial: output });
		}

		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		const errorMessage = lastError instanceof Error ? lastError.message : JSON.stringify(lastError);
		output.errorMessage = attempts > 1 ? `${errorMessage} (after ${attempts} attempts)` : errorMessage;

		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	})();

	return stream;
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
): { client: Anthropic; isOAuthToken: boolean } {
	const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
	if (interleavedThinking) {
		betaFeatures.push("interleaved-thinking-2025-05-14");
	}

	const oauthToken = isOAuthToken(apiKey);
	if (oauthToken) {
		const defaultHeaders = {
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
			"user-agent": `claude-cli/${claudeCodeVersion} (external, cli)`,
			"x-app": "cli",
			...(model.headers || {}),
		};

		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			defaultHeaders,
			dangerouslyAllowBrowser: true,
		});

		return { client, isOAuthToken: true };
	}

	const defaultHeaders = {
		accept: "application/json",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta": betaFeatures.join(","),
		...(model.headers || {}),
	};

	const client = new Anthropic({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});

	return { client, isOAuthToken: false };
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				cache_control: {
					type: "ephemeral",
				},
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				cache_control: {
					type: "ephemeral",
				},
			});
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				cache_control: {
					type: "ephemeral",
				},
			},
		];
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools);
	}

	if (options?.thinkingEnabled && model.reasoning) {
		params.thinking = {
			type: "enabled",
			budget_tokens: options.thinkingBudgetTokens || 1024,
		};
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = {
				type: "tool",
				name: options.toolChoice.name,
			};
		}
	}

	return params;
}

// Sanitize tool call IDs to match Anthropic's required pattern: ^[a-zA-Z0-9_-]+$
function sanitizeToolCallId(id: string): string {
	// Replace any character that isn't alphanumeric, underscore, or hyphen with underscore
	return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function shouldSendSignaturelessThinkingBlocks(model: Model<"anthropic-messages">): boolean {
	// Anthropic's official API requires a thinking signature to be re-submitted.
	// Many third-party / Anthropic-compatible endpoints do NOT provide signatures, and/or
	// accept signature-less thinking blocks.
	//
	// Rule: allow signature-less thinking blocks for any *non-official* Anthropic endpoint.
	return !isOfficialAnthropicBaseUrl(model.baseUrl);
}

function isOfficialAnthropicBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		// Note: if the user is proxying Anthropic through something like
		// `http://localhost:3001?url=https://api.anthropic.com`, the hostname won't match.
		// So we also fall back to substring matching against the original baseUrl.
		return url.hostname === "api.anthropic.com" || baseUrl.includes("api.anthropic.com");
	} catch {
		return baseUrl.includes("api.anthropic.com");
	}
}

function convertMessages(messages: Message[], model: Model<"anthropic-messages">): MessageParam[] {
	const params: MessageParam[] = [];

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(messages, model);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				let filteredBlocks = !model?.input.includes("image") ? blocks.filter((b) => b.type !== "image") : blocks;
				filteredBlocks = filteredBlocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					if (block.thinking.trim().length === 0) continue;
					const signature = block.thinkingSignature?.trim() ?? "";
					if (signature.length > 0) {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature,
						});
					} else if (shouldSendSignaturelessThinkingBlocks(model)) {
						// Synthetic-compatible: allow signature-less thinking blocks.
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
						} as unknown as ContentBlockParam);
					} else {
						// Missing signature => send as plain text to avoid API rejection.
						blocks.push({
							type: "text",
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: sanitizeToolCallId(block.id),
						name: block.name,
						input: block.arguments,
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Batch consecutive tool results (required by z.ai Anthropic endpoint)
			const toolResults: ContentBlockParam[] = [];

			toolResults.push({
				type: "tool_result",
				tool_use_id: sanitizeToolCallId(msg.toolCallId),
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: sanitizeToolCallId(nextMsg.toolCallId),
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			i = j - 1; // Skip processed messages

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			// Add cache control to the last content block
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = { type: "ephemeral" };
				}
			}
		}
	}

	return params;
}

function convertTools(tools: Tool[]): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool) => {
		const jsonSchema = tool.parameters as any; // TypeBox already generates JSON Schema

		return {
			name: tool.name,
			description: tool.description,
			input_schema: {
				type: "object" as const,
				properties: jsonSchema.properties || {},
				required: jsonSchema.required || [],
			},
		};
	});
}

function mapStopReason(reason: Anthropic.Messages.StopReason): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
