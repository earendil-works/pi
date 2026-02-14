import OpenAI from "openai";
import { calculateCost } from "../models.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transorm-messages.js";
/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	// Start async processing
	(async () => {
		const output = {
			role: "assistant",
			content: [],
			api: "openai-responses",
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
			let sawCompletion = false;
			let hadContent = false;
			// Create OpenAI client
			const client = createClient(model, options?.apiKey);
			const params = buildParams(model, context, options);
			const openaiStream = await client.responses.create(params, { signal: options?.signal });
			stream.push({ type: "start", partial: output });
			let currentItem = null;
			let currentBlock = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const event of openaiStream) {
				// Handle output item start
				if (event.type === "response.output_item.added") {
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
							id: item.call_id + "|" + item.id,
							name: item.name,
							arguments: {},
							partialJson: item.arguments || "",
						};
						output.content.push(currentBlock);
						stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
					}
				}
				// Handle reasoning summary deltas
				else if (event.type === "response.reasoning_summary_part.added") {
					if (currentItem && currentItem.type === "reasoning") {
						currentItem.summary = currentItem.summary || [];
						currentItem.summary.push(event.part);
					}
				} else if (event.type === "response.reasoning_summary_text.delta") {
					if (
						currentItem &&
						currentItem.type === "reasoning" &&
						currentBlock &&
						currentBlock.type === "thinking"
					) {
						currentItem.summary = currentItem.summary || [];
						const lastPart = currentItem.summary[currentItem.summary.length - 1];
						if (lastPart) {
							currentBlock.thinking += event.delta;
							lastPart.text += event.delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: event.delta,
								partial: output,
							});
						}
					}
				}
				// Add a new line between summary parts (hack...)
				else if (event.type === "response.reasoning_summary_part.done") {
					if (
						currentItem &&
						currentItem.type === "reasoning" &&
						currentBlock &&
						currentBlock.type === "thinking"
					) {
						currentItem.summary = currentItem.summary || [];
						const lastPart = currentItem.summary[currentItem.summary.length - 1];
						if (lastPart) {
							currentBlock.thinking += "\n\n";
							lastPart.text += "\n\n";
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: "\n\n",
								partial: output,
							});
						}
					}
				}
				// Handle text output deltas
				else if (event.type === "response.content_part.added") {
					if (currentItem && currentItem.type === "message") {
						currentItem.content = currentItem.content || [];
						currentItem.content.push(event.part);
					}
				} else if (event.type === "response.output_text.delta") {
					if (currentItem && currentItem.type === "message" && currentBlock && currentBlock.type === "text") {
						const lastPart = currentItem.content[currentItem.content.length - 1];
						if (lastPart && lastPart.type === "output_text") {
							currentBlock.text += event.delta;
							lastPart.text += event.delta;
							stream.push({
								type: "text_delta",
								contentIndex: blockIndex(),
								delta: event.delta,
								partial: output,
							});
						}
					}
				} else if (event.type === "response.refusal.delta") {
					if (currentItem && currentItem.type === "message" && currentBlock && currentBlock.type === "text") {
						const lastPart = currentItem.content[currentItem.content.length - 1];
						if (lastPart && lastPart.type === "refusal") {
							currentBlock.text += event.delta;
							lastPart.refusal += event.delta;
							stream.push({
								type: "text_delta",
								contentIndex: blockIndex(),
								delta: event.delta,
								partial: output,
							});
						}
					}
				}
				// Handle function call argument deltas
				else if (event.type === "response.function_call_arguments.delta") {
					if (
						currentItem &&
						currentItem.type === "function_call" &&
						currentBlock &&
						currentBlock.type === "toolCall"
					) {
						hadContent = true;
						currentBlock.partialJson += event.delta;
						currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta: event.delta,
							partial: output,
						});
					}
				}
				// Handle output item completion
				else if (event.type === "response.output_item.done") {
					const item = event.item;
					if (item.type === "reasoning" && currentBlock && currentBlock.type === "thinking") {
						hadContent = true;
						currentBlock.thinking = item.summary?.map((s) => s.text).join("\n\n") || "";
						currentBlock.thinkingSignature = JSON.stringify(item);
						stream.push({
							type: "thinking_end",
							contentIndex: blockIndex(),
							content: currentBlock.thinking,
							partial: output,
						});
						currentBlock = null;
					} else if (item.type === "message" && currentBlock && currentBlock.type === "text") {
						hadContent = true;
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
						hadContent = true;
						// Use accumulated partialJson as fallback if item.arguments is empty/missing
						const argsStr =
							item.arguments || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "{}") || "{}";
						const toolCall = {
							type: "toolCall",
							id: item.call_id + "|" + item.id,
							name: item.name,
							arguments: JSON.parse(argsStr),
						};
						stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						currentBlock = null;
					}
				}
				// Handle completion
				else if (event.type === "response.completed") {
					sawCompletion = true;
					const response = event.response;
					if (response?.usage) {
						// Support both OpenAI (input_tokens/output_tokens) and
						// Fireworks-style (prompt_tokens/completion_tokens) field names
						const usage = response.usage;
						const rawInput = usage.input_tokens ?? usage.prompt_tokens ?? 0;
						const rawOutput = usage.output_tokens ?? usage.completion_tokens ?? 0;
						const cachedTokens = response.usage.input_tokens_details?.cached_tokens ?? 0;
						const input = rawInput - cachedTokens;
						output.usage = {
							// OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input
							input,
							output: rawOutput,
							cacheRead: cachedTokens,
							cacheWrite: 0,
							totalTokens: input + rawOutput + cachedTokens,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
					}
					calculateCost(model, output.usage);
					if (response?.status === "queued" || response?.status === "in_progress") {
						throw new Error(`Stream ended with non-terminal status: ${response.status}`);
					}
					// Map status to stop reason
					output.stopReason = mapStopReason(response?.status);
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}
				// Handle errors
				else if (event.type === "error") {
					throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
				} else if (event.type === "response.failed") {
					throw new Error("OpenAI response failed");
				}
			}
			if (!sawCompletion) {
				throw new Error(hadContent ? "Stream terminated before completion" : "Stream terminated");
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "OpenAI response failed");
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete block.index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};
function createClient(model, apiKey) {
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
function buildParams(model, context, options) {
	const messages = convertMessages(model, context);
	const params = {
		model: model.id,
		input: messages,
		stream: true,
	};
	// Merge extra body fields first as defaults (model-specific params from models.json)
	if (model.extraBody) {
		Object.assign(params, model.extraBody);
	}
	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
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
	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			// Map 'xhigh' to 'high' for OpenAI compatibility as 'xhigh' is not a standard OpenAI value
			const effort = options?.reasoningEffort === "xhigh" ? "high" : options?.reasoningEffort || "medium";
			params.reasoning = {
				effort: effort,
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else {
			if (model.name.startsWith("gpt-5")) {
				// Jesus Christ, see https://community.openai.com/t/need-reasoning-false-option-for-gpt-5/1351588/7
				messages.push({
					role: "developer",
					content: [
						{
							type: "input_text",
							text: "# Juice: 0 !important",
						},
					],
				});
			}
		}
	}
	return params;
}
function convertMessages(model, context) {
	const messages = [];
	const transformedMessages = transformMessages(context.messages, model);
	if (context.systemPrompt) {
		// Default to "system" role - only native OpenAI reasoning models use "developer"
		let role = "system";
		if (model.reasoning && model.baseUrl.includes("api.openai.com")) {
			role = "developer";
		}
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "input_image",
							detail: "auto",
							image_url: `data:${item.mimeType};base64,${item.data}`,
						};
					}
				});
				const filteredContent = !model.input.includes("image")
					? content.filter((c) => c.type !== "input_image")
					: content;
				if (filteredContent.length === 0) continue;
				messages.push({
					role: "user",
					content: filteredContent,
				});
			}
		} else if (msg.role === "assistant") {
			const output = [];
			for (const block of msg.content) {
				// Do not submit thinking blocks if the completion had an error (i.e. abort)
				if (block.type === "thinking" && msg.stopReason !== "error") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature);
						output.push(reasoningItem);
					} else if (block.thinking.trim().length > 0) {
						// Cross-provider history has no OpenAI reasoning signature; preserve it as a reasoning item.
						// OpenAI docs recommend re-sending prior reasoning items for subsequent turns.
						const fullThinking = sanitizeSurrogates(block.thinking);
						const summaryText = fullThinking.length > 1500 ? fullThinking.slice(0, 1500) : fullThinking;
						output.push({
							type: "reasoning",
							id: "reasoning_" + Math.random().toString(36).substring(2, 15),
							summary: [
								{
									type: "summary_text",
									text: summaryText,
								},
							],
							content: [
								{
									type: "reasoning_text",
									text: fullThinking,
								},
							],
						});
					}
				} else if (block.type === "text") {
					const textBlock = block;
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: textBlock.textSignature || "msg_" + Math.random().toString(36).substring(2, 15),
					});
					// Do not submit toolcall blocks if the completion had an error (i.e. abort)
				} else if (block.type === "toolCall" && msg.stopReason !== "error") {
					const toolCall = block;
					output.push({
						type: "function_call",
						id: toolCall.id.split("|")[1],
						call_id: toolCall.id.split("|")[0],
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c) => c.type === "image");
			// Always send function_call_output with text (or placeholder if only images)
			const hasText = textResult.length > 0;
			messages.push({
				type: "function_call_output",
				call_id: msg.toolCallId.split("|")[0],
				output: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
			});
			// If there are images and model supports them, send a follow-up user message with images
			if (hasImages && model.input.includes("image")) {
				const contentParts = [];
				// Add text prefix
				contentParts.push({
					type: "input_text",
					text: "Attached image(s) from tool result:",
				});
				// Add images
				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}
				messages.push({
					role: "user",
					content: contentParts,
				});
			}
		}
	}
	return messages;
}
function convertTools(tools) {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters, // TypeBox already generates JSON Schema
		strict: null,
	}));
}
function mapStopReason(status) {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "error";
		default: {
			const _exhaustive = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
//# sourceMappingURL=openai-responses.js.map
