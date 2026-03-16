import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { calculateCost } from "../models.js";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	OpenAICompat,
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
import { transformMessages } from "./transorm-messages.js";

/**
 * Normalize tool call ID for Mistral.
 * Mistral requires tool IDs to be exactly 9 alphanumeric characters (a-z, A-Z, 0-9).
 */
function normalizeMistralToolId(id: string, isMistral: boolean): string {
	if (!isMistral) return id;
	// Remove non-alphanumeric characters
	let normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	// Mistral requires exactly 9 characters
	if (normalized.length < 9) {
		// Pad with deterministic characters based on original ID to ensure matching
		const padding = "ABCDEFGHI";
		normalized = normalized + padding.slice(0, 9 - normalized.length);
	} else if (normalized.length > 9) {
		normalized = normalized.slice(0, 9);
	}
	return normalized;
}

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

function isGptFamilyModelId(modelId: string): boolean {
	const normalized = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	return normalized.toLowerCase().startsWith("gpt");
}

/**
 * Auto-detect OpenAI-completions compatibility settings from URL.
 */
function detectCompatFromUrl(baseUrl: string): Required<OpenAICompat> {
	const isMoonshot = baseUrl.includes("api.moonshot.ai");

	const isNonStandard =
		isMoonshot ||
		baseUrl.includes("cerebras.ai") ||
		baseUrl.includes("api.x.ai") ||
		baseUrl.includes("mistral.ai") ||
		baseUrl.includes("chutes.ai") ||
		baseUrl.includes("fireworks.ai") ||
		baseUrl.includes("api.z.ai");

	const useMaxTokens =
		isMoonshot || baseUrl.includes("mistral.ai") || baseUrl.includes("chutes.ai") || baseUrl.includes("fireworks.ai");

	const isGrok = baseUrl.includes("api.x.ai");

	const isMistral = baseUrl.includes("mistral.ai");

	const isFireworks = baseUrl.includes("fireworks.ai");

	const isZAI = baseUrl.includes("api.z.ai");

	const isOpenAI = baseUrl.includes("openai.com");

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenAI,
		// Moonshot uses a different "thinking" mechanism; don't send OpenAI-style reasoning_effort.
		supportsReasoningEffort: !isMoonshot && !isGrok && !isZAI,
		reasoningEffortFormat: "string",
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: isMistral,
		requiresAssistantAfterToolResult: false, // Mistral no longer requires this as of Dec 2024
		requiresThinkingAsText: isMistral || isZAI,
		requiresMistralToolIds: isMistral,
		// Moonshot doesn't document OpenAI's stream_options extension; keep requests conservative.
		supportsStreamOptions: !isMoonshot && !isFireworks && !isZAI,
		isZAI,
	};
}

/**
 * Get resolved compatibility settings for a model.
 * Uses explicit model.compat if provided, otherwise auto-detects from URL.
 */
function getCompat(model: Model<"openai-completions">): Required<OpenAICompat> {
	const detected = detectCompatFromUrl(model.baseUrl);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		reasoningEffortFormat: model.compat.reasoningEffortFormat ?? detected.reasoningEffortFormat,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresMistralToolIds: model.compat.requiresMistralToolIds ?? detected.requiresMistralToolIds,
		supportsStreamOptions: model.compat.supportsStreamOptions ?? detected.supportsStreamOptions,
		isZAI: model.compat.isZAI ?? detected.isZAI,
	};
}

function isBasetenBaseUrl(baseUrl: string): boolean {
	return baseUrl.includes("inference.baseten.co");
}

function isBasetenThinkingModel(model: Model<"openai-completions">): boolean {
	if (!isBasetenBaseUrl(model.baseUrl)) return false;
	const modelId = model.id.toLowerCase();
	return modelId.includes("kimi-k2.5") || modelId.includes("glm");
}

function isBasetenReasoningEffortModel(model: Model<"openai-completions">): boolean {
	if (!isBasetenBaseUrl(model.baseUrl)) return false;
	const modelId = model.id.toLowerCase();
	return modelId === "openai/gpt-oss-120b" || modelId.endsWith("/gpt-oss-120b");
}

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

function getNonEmptyStringField(source: unknown, field: string): string | null {
	if (!source || typeof source !== "object") return null;
	const value = (source as Record<string, unknown>)[field];
	return typeof value === "string" && value.length > 0 ? value : null;
}

interface OpenAIToolCallDelta {
	id?: string | null;
	function?: {
		name?: string | null;
		arguments?: string | null;
	} | null;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
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
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const client = createClient(model, options?.apiKey);
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
					const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens || 0;
					const input = (chunk.usage.prompt_tokens || 0) - cachedTokens;
					const outputTokens = (chunk.usage.completion_tokens || 0) + reasoningTokens;
					output.usage = {
						// OpenAI includes cached tokens in prompt_tokens, so subtract to get non-cached input
						input,
						output: outputTokens,
						cacheRead: cachedTokens,
						cacheWrite: 0,
						// Compute totalTokens ourselves since we add reasoning_tokens to output
						totalTokens: input + outputTokens + cachedTokens,
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
				const choiceWithMessage = choice as ChatCompletionChunk.Choice & {
					message?: {
						content?: string | null;
						reasoning_content?: string | null;
						reasoning?: string | null;
						tool_calls?: OpenAIToolCallDelta[];
					};
				};

				if (choice.finish_reason) {
					output.stopReason = mapStopReason(choice.finish_reason);
				}

				const contentDelta =
					getNonEmptyStringField(choice.delta, "content") ??
					getNonEmptyStringField(choiceWithMessage.message, "content");
				if (contentDelta) {
					// Parse <think> tags from content (used by DeepSeek, Qwen, etc.)
					const segments = splitThinkSegments(contentDelta, thinkParseState);

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
				// or reasoning (other OpenAI-compatible endpoints).
				// Baseten may return these on choice.message instead of choice.delta.
				const reasoningFields = ["reasoning_content", "reasoning"];
				for (const field of reasoningFields) {
					const reasoningDelta =
						getNonEmptyStringField(choice.delta, field) ??
						getNonEmptyStringField(choiceWithMessage.message, field);
					if (reasoningDelta) {
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
							currentBlock.thinking += reasoningDelta;
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: reasoningDelta,
								partial: output,
							});
						}
					}
				}

				const toolCalls =
					choice.delta?.tool_calls && choice.delta.tool_calls.length > 0
						? (choice.delta.tool_calls as OpenAIToolCallDelta[])
						: choiceWithMessage.message?.tool_calls && choiceWithMessage.message.tool_calls.length > 0
							? choiceWithMessage.message.tool_calls
							: null;
				if (toolCalls) {
					for (const toolCall of toolCalls) {
						// Use function.name to detect new tool calls (not id).
						// Fireworks sends different ids for continuation chunks of the same tool call.
						const hasName =
							toolCall.function?.name !== null &&
							toolCall.function?.name !== undefined &&
							toolCall.function.name.length > 0;
						if (!currentBlock || currentBlock.type !== "toolCall" || hasName) {
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

function createClient(model: Model<"openai-completions">, apiKey?: string) {
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: model.headers,
	});
}

function buildParams(model: Model<"openai-completions">, context: Context, options?: OpenAICompletionsOptions) {
	const compat = getCompat(model);
	const messages = convertMessages(model, context, compat);

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
	};

	// Merge extra body fields first as defaults (model-specific params from models.json)
	// These can include temperature, max_tokens, top_p, etc. per provider/model
	if (model.extraBody) {
		Object.assign(params, model.extraBody);
	}

	// Only include stream_options if supported (not supported by Fireworks, etc.)
	if (compat.supportsStreamOptions) {
		params.stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	// Options override defaults from extraBody
	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			(params as any).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools);
	} else if (hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results
		params.tools = [];
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if (options?.fastMode && isGptFamilyModelId(model.id)) {
		params.service_tier = "priority";
	}

	if (options?.reasoningEffort && model.reasoning) {
		// Baseten uses chat_template_args.enable_thinking for Kimi K2.5 and GLM models.
		if (isBasetenThinkingModel(model)) {
			const paramsRecord = params as unknown as Record<string, unknown>;
			const existingChatTemplateArgs = paramsRecord.chat_template_args;
			const chatTemplateArgs =
				existingChatTemplateArgs &&
				typeof existingChatTemplateArgs === "object" &&
				!Array.isArray(existingChatTemplateArgs)
					? (existingChatTemplateArgs as Record<string, unknown>)
					: {};
			paramsRecord.chat_template_args = {
				...chatTemplateArgs,
				enable_thinking: true,
			};
		}

		// Baseten currently supports reasoning_effort only on openai/gpt-oss-120b.
		const allowReasoningEffort =
			compat.supportsReasoningEffort && (!isBasetenBaseUrl(model.baseUrl) || isBasetenReasoningEffortModel(model));
		if (allowReasoningEffort) {
			if (compat.reasoningEffortFormat === "boolean") {
				// Fireworks uses boolean: any effort level (minimal/low/medium/high/xhigh) maps to true
				(params as unknown as Record<string, unknown>).reasoning_effort = true;
			} else {
				// OpenAI uses string: low/medium/high
				// Map 'minimal' to 'low' and 'xhigh' to 'high' for OpenAI compatibility
				let effort: string = options.reasoningEffort;
				if (effort === "minimal") effort = "low";
				if (effort === "xhigh") effort = "high";
				params.reasoning_effort = effort as "low" | "medium" | "high";
			}
		}
	}

	return params;
}

function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: Required<OpenAICompat>,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const transformedMessages = transformMessages(context.messages, model);

	if (context.systemPrompt) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		params.push({ role: role, content: sanitizeSurrogates(context.systemPrompt) });
	}

	let lastRole: string | null = null;

	for (const msg of transformedMessages) {
		// Some providers (e.g. Mistral/Devstral) don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
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
			lastRole = "user";
		} else if (msg.role === "assistant") {
			const assistantMsg: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: null,
			};

			const textBlocks = msg.content.filter((b) => b.type === "text") as TextContent[];
			const thinkingBlocks = msg.content.filter((b) => b.type === "thinking") as ThinkingContent[];
			const toolCalls = msg.content.filter((b) => b.type === "toolCall") as ToolCall[];

			// Build content parts: thinking first, then text
			const contentParts: { type: "text"; text: string }[] = [];

			// Handle thinking blocks based on model's reasoningFormat or compat settings
			if (thinkingBlocks.length > 0) {
				const joinedThinking = thinkingBlocks
					.map((b) => b.thinking)
					.join("\n")
					.trim();
				if (joinedThinking.length > 0) {
					if (model.reasoningFormat === "reasoning_content") {
						// DeepSeek-style: separate field on assistant message
						(assistantMsg as any).reasoning_content = joinedThinking;
					} else if (compat.requiresThinkingAsText) {
						// Mistral-style: <thinking> delimiters
						contentParts.push({
							type: "text",
							text: sanitizeSurrogates(`<thinking>\n${joinedThinking}\n</thinking>`),
						});
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
					id: normalizeMistralToolId(tc.id, compat.requiresMistralToolIds),
					type: "function" as const,
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.arguments),
					},
				}));
			}

			if (assistantMsg.content === null && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
			lastRole = "assistant";
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => (c as any).text)
				.join("\n");
			const hasImages = msg.content.some((c) => c.type === "image");

			// Always send tool result with text (or placeholder if only images)
			const hasText = textResult.length > 0;
			const toolMsg: ChatCompletionToolMessageParam = {
				role: "tool",
				content: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
				tool_call_id: normalizeMistralToolId(msg.toolCallId, compat.requiresMistralToolIds),
			};
			// Mistral requires the name field on tool results
			if (compat.requiresToolResultName) {
				(toolMsg as any).name = msg.toolName;
			}
			params.push(toolMsg);
			lastRole = "toolResult";

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
	// Use a wide string type so non-standard finish_reason values from
	// OpenAI-compatible endpoints don't cause type errors.
	const r = reason as string;
	switch (r) {
		case "stop":
			return "stop";
		case "length":
		case "model_context_window_exceeded":
			return "length";
		case "function_call":
		case "tool_calls":
			return "toolUse";
		case "content_filter":
		case "network_error":
		default:
			return "error";
	}
}
