import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import { calculateCost } from "../models.js";
import type {
	AssistantMessage,
	Context,
	Model,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { validateToolArguments } from "../utils/validation.js";
import { transformMessages } from "./transorm-messages.js";

// State machine for parsing <think> tags from streaming content
// Many open-source models (DeepSeek, Qwen, etc.) output reasoning in <think> tags
interface ThinkParseState {
	mode: "text" | "think";
	buffer: string;
}

interface ThinkSegment {
	kind: "text" | "thinking";
	chunk: string;
}

function createThinkParseState(): ThinkParseState {
	return { mode: "text", buffer: "" };
}

// Parse streaming content for <think> tags, returning segments with their types
function splitThinkSegments(input: string, state: ThinkParseState): ThinkSegment[] {
	const segments: ThinkSegment[] = [];
	state.buffer += input;

	while (state.buffer.length > 0) {
		if (state.mode === "text") {
			// Look for opening <think> tag
			const thinkStart = state.buffer.indexOf("<think>");
			if (thinkStart === -1) {
				// No <think> tag found - check if we might be in the middle of one
				// Keep potential partial tag in buffer (at most 6 chars: "<think")
				const potentialTagStart = state.buffer.lastIndexOf("<");
				if (potentialTagStart !== -1 && potentialTagStart > state.buffer.length - 7) {
					// Might be start of <think>, emit everything before it
					if (potentialTagStart > 0) {
						segments.push({ kind: "text", chunk: state.buffer.substring(0, potentialTagStart) });
					}
					state.buffer = state.buffer.substring(potentialTagStart);
					break;
				}
				// Emit all as text
				if (state.buffer.length > 0) {
					segments.push({ kind: "text", chunk: state.buffer });
				}
				state.buffer = "";
				break;
			}

			// Found <think> tag
			if (thinkStart > 0) {
				segments.push({ kind: "text", chunk: state.buffer.substring(0, thinkStart) });
			}
			state.buffer = state.buffer.substring(thinkStart + 7); // Skip "<think>"
			state.mode = "think";
		} else {
			// In think mode - look for closing </think> tag
			const thinkEnd = state.buffer.indexOf("</think>");
			if (thinkEnd === -1) {
				// No closing tag yet - check for partial
				const potentialTagStart = state.buffer.lastIndexOf("<");
				if (potentialTagStart !== -1 && potentialTagStart > state.buffer.length - 8) {
					// Might be start of </think>, emit everything before it
					if (potentialTagStart > 0) {
						segments.push({ kind: "thinking", chunk: state.buffer.substring(0, potentialTagStart) });
					}
					state.buffer = state.buffer.substring(potentialTagStart);
					break;
				}
				// Emit all as thinking
				if (state.buffer.length > 0) {
					segments.push({ kind: "thinking", chunk: state.buffer });
				}
				state.buffer = "";
				break;
			}

			// Found </think> tag
			if (thinkEnd > 0) {
				segments.push({ kind: "thinking", chunk: state.buffer.substring(0, thinkEnd) });
			}
			state.buffer = state.buffer.substring(thinkEnd + 8); // Skip "</think>"
			state.mode = "text";
		}
	}

	return segments;
}

// Flush any remaining content in the buffer when stream ends
function flushThinkParseState(state: ThinkParseState): ThinkSegment[] {
	if (state.buffer.length === 0) return [];

	const segment: ThinkSegment = {
		kind: state.mode === "think" ? "thinking" : "text",
		chunk: state.buffer,
	};
	state.buffer = "";
	return [segment];
}

// Parse JSON that might be double-encoded (some models produce this)
function parsePossiblyDoubleEncoded(jsonStr: string | undefined): Record<string, unknown> {
	const first = parseStreamingJson<unknown>(jsonStr);
	// If first parse returned a string, try parsing it again
	if (typeof first === "string") {
		try {
			return JSON.parse(first) as Record<string, unknown>;
		} catch {
			// Double-parse failed, return empty object to maintain type safety
			return {};
		}
	}
	// Ensure we return an object, not a primitive
	if (first === null || typeof first !== "object") {
		return {};
	}
	return first as Record<string, unknown>;
}

// Roo Code identification headers - used to make requests appear as coming from Roo Code
// See: https://github.com/RooCodeInc/Roo-Code/blob/main/src/api/providers/constants.ts
const ROOCODE_VERSION = "3.36.2";
export const ROOCODE_HEADERS = {
	"HTTP-Referer": "https://github.com/RooVetGit/Roo-Cline",
	"X-Title": "Roo Code",
	"User-Agent": `RooCode/${ROOCODE_VERSION}`,
} as const;

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	reasoningEffort?: "minimal" | "low" | "medium" | "high";
	/**
	 * When true, enables Roo Code compatibility mode:
	 * - Sets Roo Code identification headers (HTTP-Referer, X-Title, User-Agent)
	 * - Uses legacy OpenAI message format (simple string content instead of content arrays)
	 * - Forces max_tokens to be included in requests
	 *
	 * Useful for providers that offer special features/pricing for Roo Code users
	 * (e.g., Kimi For Coding: https://api.kimi.com/coding/v1)
	 */
	roocodeCompatible?: boolean;
}

export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const client = createClient(model, options);
			const params = buildParams(model, context, options);
			const openaiStream = await client.chat.completions.create(params, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			let currentBlock: TextContent | ThinkingContent | (ToolCall & { partialArgs?: string }) | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			// State machine for parsing <think> tags embedded in content
			const thinkParseState = createThinkParseState();
			const finishCurrentBlock = (block?: typeof currentBlock) => {
				if (block) {
					if (block.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: blockIndex(),
							content: block.text,
							partial: output,
						});
					} else if (block.type === "thinking") {
						stream.push({
							type: "thinking_end",
							contentIndex: blockIndex(),
							content: block.thinking,
							partial: output,
						});
					} else if (block.type === "toolCall") {
						// Handle double-encoded JSON (some models produce this)
						block.arguments = parsePossiblyDoubleEncoded(block.partialArgs);

						// Validate tool arguments if tool definition is available
						if (context.tools) {
							const tool = context.tools.find((t) => t.name === block.name);
							if (tool) {
								block.arguments = validateToolArguments(tool, block);
							}
						}

						delete block.partialArgs;
						stream.push({
							type: "toolcall_end",
							contentIndex: blockIndex(),
							toolCall: block,
							partial: output,
						});
					}
				}
			};

			for await (const chunk of openaiStream) {
				if (chunk.usage) {
					const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
					output.usage = {
						// OpenAI includes cached tokens in prompt_tokens, so subtract to get non-cached input
						input: (chunk.usage.prompt_tokens || 0) - cachedTokens,
						output:
							(chunk.usage.completion_tokens || 0) +
							(chunk.usage.completion_tokens_details?.reasoning_tokens || 0),
						cacheRead: cachedTokens,
						cacheWrite: 0,
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

				const choice = chunk.choices[0];
				if (!choice) continue;

				if (choice.finish_reason) {
					output.stopReason = mapStopReason(choice.finish_reason);
				}

				if (choice.delta) {
					if (
						choice.delta.content !== null &&
						choice.delta.content !== undefined &&
						choice.delta.content.length > 0
					) {
						// Parse <think> tags from content (used by DeepSeek, Qwen, etc.)
						const segments = splitThinkSegments(choice.delta.content, thinkParseState);

						for (const segment of segments) {
							if (segment.kind === "thinking") {
								// Switch to thinking block if needed
								if (!currentBlock || currentBlock.type !== "thinking") {
									finishCurrentBlock(currentBlock);
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: "think_tag" };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								}
								if (currentBlock.type === "thinking") {
									currentBlock.thinking += segment.chunk;
									stream.push({
										type: "thinking_delta",
										contentIndex: blockIndex(),
										delta: segment.chunk,
										partial: output,
									});
								}
							} else {
								// Text segment - switch to text block if needed
								if (!currentBlock || currentBlock.type !== "text") {
									finishCurrentBlock(currentBlock);
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
								if (currentBlock.type === "text") {
									currentBlock.text += segment.chunk;
									stream.push({
										type: "text_delta",
										contentIndex: blockIndex(),
										delta: segment.chunk,
										partial: output,
									});
								}
							}
						}
					}

					// Some endpoints return reasoning in reasoning_content (llama.cpp),
					// or reasoning (other openai compatible endpoints)
					const reasoningFields = ["reasoning_content", "reasoning"];
					for (const field of reasoningFields) {
						if (
							(choice.delta as any)[field] !== null &&
							(choice.delta as any)[field] !== undefined &&
							(choice.delta as any)[field].length > 0
						) {
							if (!currentBlock || currentBlock.type !== "thinking") {
								finishCurrentBlock(currentBlock);
								currentBlock = {
									type: "thinking",
									thinking: "",
									thinkingSignature: field,
								};
								output.content.push(currentBlock);
								stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
							}

							if (currentBlock.type === "thinking") {
								const delta = (choice.delta as any)[field];
								currentBlock.thinking += delta;
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta,
									partial: output,
								});
							}
						}
					}

					if (choice?.delta?.tool_calls) {
						for (const toolCall of choice.delta.tool_calls) {
							if (
								!currentBlock ||
								currentBlock.type !== "toolCall" ||
								(toolCall.id && currentBlock.id !== toolCall.id)
							) {
								finishCurrentBlock(currentBlock);
								currentBlock = {
									type: "toolCall",
									id: toolCall.id || "",
									name: toolCall.function?.name || "",
									arguments: {},
									partialArgs: "",
								};
								output.content.push(currentBlock);
								stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							}

							if (currentBlock.type === "toolCall") {
								if (toolCall.id) currentBlock.id = toolCall.id;
								if (toolCall.function?.name) currentBlock.name = toolCall.function.name;
								let delta = "";
								if (toolCall.function?.arguments) {
									delta = toolCall.function.arguments;
									currentBlock.partialArgs += toolCall.function.arguments;
									currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
								}
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta,
									partial: output,
								});
							}
						}
					}
				}
			}

			// Flush any remaining content in the think parse buffer
			const remainingSegments = flushThinkParseState(thinkParseState);
			for (const segment of remainingSegments) {
				if (segment.kind === "thinking") {
					if (!currentBlock || currentBlock.type !== "thinking") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "thinking", thinking: "", thinkingSignature: "think_tag" };
						output.content.push(currentBlock);
						stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
					}
					if (currentBlock.type === "thinking") {
						currentBlock.thinking += segment.chunk;
						stream.push({
							type: "thinking_delta",
							contentIndex: blockIndex(),
							delta: segment.chunk,
							partial: output,
						});
					}
				} else {
					if (!currentBlock || currentBlock.type !== "text") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "text", text: "" };
						output.content.push(currentBlock);
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}
					if (currentBlock.type === "text") {
						currentBlock.text += segment.chunk;
						stream.push({
							type: "text_delta",
							contentIndex: blockIndex(),
							delta: segment.chunk,
							partial: output,
						});
					}
				}
			}

			finishCurrentBlock(currentBlock);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unkown error ocurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function createClient(model: Model<"openai-completions">, options?: OpenAICompletionsOptions) {
	let apiKey = options?.apiKey;
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}

	// Check roocodeCompatible from model config or options (options takes precedence)
	const roocodeCompatible = options?.roocodeCompatible ?? model.roocodeCompatible ?? false;

	// Merge headers: model headers first, then Roo Code headers if enabled
	const headers: Record<string, string> = { ...model.headers };
	if (roocodeCompatible) {
		Object.assign(headers, ROOCODE_HEADERS);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
	});
}

function buildParams(model: Model<"openai-completions">, context: Context, options?: OpenAICompletionsOptions) {
	// Check roocodeCompatible from model config or options (options takes precedence)
	const roocodeCompatible = options?.roocodeCompatible ?? model.roocodeCompatible ?? false;

	const messages = convertMessages(model, context, options, roocodeCompatible);

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		stream_options: { include_usage: true },
	};

	// Cerebras/xAI/Mistral dont like the "store" field
	if (
		!model.baseUrl.includes("cerebras.ai") &&
		!model.baseUrl.includes("api.x.ai") &&
		!model.baseUrl.includes("mistral.ai") &&
		!model.baseUrl.includes("chutes.ai")
	) {
		params.store = false;
	}

	// Handle max tokens - roocodeCompatible forces it to be included (uses legacy max_tokens)
	const maxTokens = options?.maxTokens ?? (roocodeCompatible ? model.maxTokens : undefined);
	if (maxTokens) {
		// Mistral/Chutes and roocodeCompatible use legacy max_tokens instead of max_completion_tokens
		if (model.baseUrl.includes("mistral.ai") || model.baseUrl.includes("chutes.ai") || roocodeCompatible) {
			(params as any).max_tokens = maxTokens;
		} else {
			params.max_completion_tokens = maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools);
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	// Grok models don't like reasoning_effort
	if (options?.reasoningEffort && model.reasoning && !model.id.toLowerCase().includes("grok")) {
		params.reasoning_effort = options.reasoningEffort;
	}

	// Merge extra body fields from model config
	if (model.extraBody) {
		Object.assign(params, model.extraBody);
	}

	return params;
}

function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
	roocodeCompatible?: boolean,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];
	const useLegacyFormat = roocodeCompatible ?? options?.roocodeCompatible ?? model.roocodeCompatible ?? false;

	const transformedMessages = transformMessages(context.messages, model);

	if (context.systemPrompt) {
		// Default to "system" role - only native OpenAI reasoning models use "developer"
		let role: "system" | "developer" = "system";
		if (model.reasoning && model.baseUrl.includes("api.openai.com")) {
			role = "developer";
		}
		params.push({ role, content: sanitizeSurrogates(context.systemPrompt) });
	}

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			} else if (useLegacyFormat) {
				// Legacy format: convert complex content to simple string
				const textContent = msg.content
					.map((item) => {
						if (item.type === "text") return item.text;
						if (item.type === "image") return "[Image]";
						return "";
					})
					.filter(Boolean)
					.join("\n");
				if (textContent.length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(textContent),
					});
				}
			} else {
				const content: ChatCompletionContentPart[] = msg.content.map((item): ChatCompletionContentPart => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						} satisfies ChatCompletionContentPartText;
					} else {
						return {
							type: "image_url",
							image_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartImage;
					}
				});
				const filteredContent = !model.input.includes("image")
					? content.filter((c) => c.type !== "image_url")
					: content;
				if (filteredContent.length === 0) continue;
				params.push({
					role: "user",
					content: filteredContent,
				});
			}
		} else if (msg.role === "assistant") {
			const assistantMsg: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: null,
			};

			const textBlocks = msg.content.filter((b) => b.type === "text") as TextContent[];
			const thinkingBlocks = msg.content.filter((b) => b.type === "thinking") as ThinkingContent[];
			const toolCalls = msg.content.filter((b) => b.type === "toolCall") as ToolCall[];

			if (useLegacyFormat) {
				// Legacy format: convert all content to simple string
				const parts: string[] = [];

				// Thinking as inline <think> tags
				if (thinkingBlocks.length > 0) {
					const joinedThinking = thinkingBlocks
						.map((b) => b.thinking)
						.join("\n")
						.trim();
					if (joinedThinking.length > 0) {
						parts.push(`<think>\n${joinedThinking}\n</think>`);
					}
				}

				// Text content
				for (const block of textBlocks) {
					if (block.text) parts.push(block.text);
				}

				// Tool calls as placeholders
				for (const tc of toolCalls) {
					parts.push(`[Tool Use: ${tc.name}]`);
				}

				if (parts.length > 0) {
					assistantMsg.content = sanitizeSurrogates(parts.join("\n"));
				}

				// Tool calls still need to be included for function calling to work
				if (toolCalls.length > 0) {
					assistantMsg.tool_calls = toolCalls.map((tc) => ({
						id: tc.id,
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					}));
				}
			} else {
				// Build content parts: thinking first, then text
				const contentParts: { type: "text"; text: string }[] = [];

				// Handle thinking blocks based on model's reasoningFormat
				if (thinkingBlocks.length > 0) {
					const joinedThinking = thinkingBlocks
						.map((b) => b.thinking)
						.join("\n")
						.trim();
					if (joinedThinking.length > 0) {
						if (model.reasoningFormat === "reasoning_content") {
							// DeepSeek-style: separate field on assistant message
							(assistantMsg as any).reasoning_content = joinedThinking;
						} else {
							// Default: inline <think> tags
							contentParts.push({
								type: "text",
								text: sanitizeSurrogates(`<think>\n${joinedThinking}\n</think>`),
							});
						}
					}
				}

				// Regular text follows
				for (const block of textBlocks) {
					if (!block.text) continue;
					contentParts.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				}

				if (contentParts.length > 0) {
					assistantMsg.content = contentParts;
				}

				// Tool calls mapped as before
				if (toolCalls.length > 0) {
					assistantMsg.tool_calls = toolCalls.map((tc) => ({
						id: tc.id,
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					}));
				}
			}

			if (assistantMsg.content === null && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => (c as any).text)
				.join("\n");
			const hasImages = msg.content.some((c) => c.type === "image");

			// Always send tool result with text (or placeholder if only images)
			const hasText = textResult.length > 0;
			params.push({
				role: "tool",
				content: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
				tool_call_id: msg.toolCallId,
			});

			// If there are images and model supports them, send a follow-up user message with images
			if (hasImages && model.input.includes("image")) {
				const contentBlocks: Array<
					{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
				> = [];

				// Add text prefix
				contentBlocks.push({
					type: "text",
					text: "Attached image(s) from tool result:",
				});

				// Add images
				for (const block of msg.content) {
					if (block.type === "image") {
						contentBlocks.push({
							type: "image_url",
							image_url: {
								url: `data:${(block as any).mimeType};base64,${(block as any).data}`,
							},
						});
					}
				}

				params.push({
					role: "user",
					content: contentBlocks,
				});
			}
		}
	}

	return params;
}

function convertTools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as any, // TypeBox already generates JSON Schema
		},
	}));
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"]): StopReason {
	if (reason === null) return "stop";
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "function_call":
		case "tool_calls":
			return "toolUse";
		case "content_filter":
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
