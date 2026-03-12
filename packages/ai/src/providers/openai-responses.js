import OpenAI from "openai";
import { getMuCompactResponseItem } from "../compact-history.js";
import { calculateCost } from "../models.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { getExponentialBackoff, sleep } from "../utils/retry.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
	normalizeToolNameWithTools,
	recoverToolCallFromTextContent,
	upsertToolCallContent,
} from "./tool-call-recovery.js";
import { transformMessages } from "./transorm-messages.js";

function isGptFamilyModelId(modelId) {
	const normalized = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	return normalized.toLowerCase().startsWith("gpt");
}
function normalizeToolName(name, tools) {
	return normalizeToolNameWithTools(name, tools);
}
function buildToolCallId(callId, itemId) {
	const lhs = callId ?? itemId ?? "";
	const rhs = itemId ?? callId ?? "";
	return `${lhs}|${rhs}`;
}
function tryParseObject(json) {
	try {
		const parsed = JSON.parse(json);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed;
		}
	} catch {
		// ignore parse errors
	}
	return null;
}
function parseToolArgumentsSafely(raw) {
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
function parseToolArgumentsForName(raw, _toolName) {
	const parsed = parseToolArgumentsSafely(raw);
	if (Object.keys(parsed).length > 0) return parsed;
	const text = raw?.trim() ?? "";
	if (!text) return {};
	return { input: text };
}
function getLocalShellCommand(item) {
	const action = asRecord(item.action);
	const command = action?.command;
	if (typeof command === "string") return command;
	if (Array.isArray(command)) {
		const parts = command.filter((part) => typeof part === "string" && part.length > 0);
		return parts.join(" ");
	}
	return "";
}
function asRecord(value) {
	return value && typeof value === "object" ? value : null;
}
function toNumber(value) {
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}
function getErrorStatus(error) {
	if (!error) return undefined;
	const record = asRecord(error);
	return toNumber(record?.status);
}
function getErrorMessage(error) {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : JSON.stringify(error);
}
class OpenAIResponsesStreamError extends Error {
	hadContent;
	status;
	code;
	constructor(message, hadContent, options) {
		super(message);
		this.name = "OpenAIResponsesStreamError";
		this.hadContent = hadContent;
		this.status = options?.status;
		this.code = options?.code;
	}
}
function getErrorCode(error) {
	if (error instanceof OpenAIResponsesStreamError) return error.code;
	const record = asRecord(error);
	const code = record?.code;
	return typeof code === "string" && code.trim() ? code : undefined;
}
/**
 * Retryable errors for OpenAI Responses.
 *
 * Important: we only retry *before* we emit any stream events, to avoid
 * duplicating partial output to the caller.
 */
function isRetryableOpenAIError(error, signal) {
	if (signal?.aborted) return false;
	const status = getErrorStatus(error);
	if (status !== undefined) {
		if (status === 408 || status === 409 || status === 429) return true;
		if (status >= 500 && status <= 599) return true;
		return false;
	}
	const code = getErrorCode(error)?.toLowerCase();
	if (code) {
		if (code === "rate_limit_exceeded" || code === "too_many_requests") return true;
		if (
			code === "server_error" ||
			code === "internal_server_error" ||
			code === "bad_gateway" ||
			code === "gateway_timeout" ||
			code === "service_unavailable"
		) {
			return true;
		}
	}
	if (error instanceof Error) {
		const message = error.message.toLowerCase();
		return (
			message.includes("fetch failed") ||
			message.includes("terminated") ||
			message.includes("network") ||
			message.includes("econnreset") ||
			message.includes("etimedout") ||
			message.includes("econnrefused")
		);
	}
	return false;
}
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
		const maxRetries = options?.retry?.maxRetries ?? 5;
		const baseDelay = options?.retry?.baseDelay ?? 200;
		const maxDelay = options?.retry?.maxDelay ?? 60000;
		let hasEmittedStart = false;
		let attempts = 0;
		let lastError;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			attempts = attempt + 1;
			// Safe because we do not emit any events until we have the first SSE frame.
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
			delete output.errorMessage;
			try {
				let sawCompletion = false;
				let hadContent = false;
				// Create OpenAI client (disable SDK retries; we handle retries here).
				const client = createClient(model, options?.apiKey, 0);
				const params = buildParams(model, context, options);
				const openaiStream = await client.responses.create(params, { signal: options?.signal });
				// Retry boundary: wait for the first event before emitting `start`.
				const iterator = openaiStream[Symbol.asyncIterator]();
				const first = await iterator.next();
				if (first.done) {
					throw new Error("Stream ended without events");
				}
				if (!hasEmittedStart) {
					stream.push({ type: "start", partial: output });
					hasEmittedStart = true;
				}
				let currentItem = null;
				let currentBlock = null;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;
				async function* events() {
					yield first.value;
					while (true) {
						const next = await iterator.next();
						if (next.done) return;
						yield next.value;
					}
				}
				for await (const event of events()) {
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
							const normalizedName = normalizeToolName(item.name, context.tools);
							currentBlock = {
								type: "toolCall",
								id: item.call_id + "|" + (item.id || ""),
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
							const normalizedName = normalizeToolName(item.name, context.tools);
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
							currentBlock.partialJson = (currentBlock.partialJson ?? "") + event.delta;
							currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: event.delta,
								partial: output,
							});
						}
					}
					// Handle finalized function call arguments
					else if (event.type === "response.function_call_arguments.done") {
						if (
							currentItem &&
							currentItem.type === "function_call" &&
							currentBlock &&
							currentBlock.type === "toolCall"
						) {
							const args = event.arguments || "";
							currentBlock.partialJson = args;
							currentBlock.arguments = parseStreamingJson(args);
						}
					}
					// Handle custom tool call argument deltas
					else if (event.type === "response.custom_tool_call_input.delta") {
						if (
							currentItem &&
							currentItem.type === "custom_tool_call" &&
							currentBlock &&
							currentBlock.type === "toolCall"
						) {
							hadContent = true;
							currentBlock.partialJson = (currentBlock.partialJson ?? "") + event.delta;
							currentBlock.arguments = parseToolArgumentsForName(currentBlock.partialJson, currentItem.name);
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: event.delta,
								partial: output,
							});
						}
					} else if (event.type === "response.custom_tool_call_input.done") {
						if (
							currentItem &&
							currentItem.type === "custom_tool_call" &&
							currentBlock &&
							currentBlock.type === "toolCall"
						) {
							const input = event.input || currentBlock.partialJson || "";
							currentBlock.partialJson = input;
							currentBlock.arguments = parseToolArgumentsForName(input, currentItem.name);
						}
					}
					// Handle output item completion
					else if (event.type === "response.output_item.done") {
						const item = event.item;
						if (item.type === "reasoning") {
							hadContent = true;
							const activeThinkingBlock = currentBlock?.type === "thinking" ? currentBlock : null;
							const hadActiveThinkingBlock = activeThinkingBlock !== null;
							const thinkingBlock = activeThinkingBlock ?? { type: "thinking", thinking: "" };
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
							const textBlock = activeTextBlock ?? { type: "text", text: "" };
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
							hadContent = true;
							const normalizedName = normalizeToolName(item.name, context.tools);
							// Use accumulated partialJson as fallback if item.arguments is empty/missing
							const argsStr =
								item.arguments || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "{}") || "{}";
							const args = parseToolArgumentsSafely(argsStr);
							if (currentBlock?.type === "toolCall") {
								currentBlock.partialJson = argsStr;
								currentBlock.arguments = args;
								delete currentBlock.partialJson;
							}
							const toolCall = {
								type: "toolCall",
								id: item.call_id + "|" + (item.id || ""),
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
							hadContent = true;
							const rawInput = item.input || (currentBlock?.type === "toolCall" ? currentBlock.partialJson : "");
							const toolName = normalizeToolName(item.name, context.tools);
							const args = parseToolArgumentsForName(rawInput, toolName);
							if (currentBlock?.type === "toolCall") {
								currentBlock.partialJson = rawInput;
								currentBlock.arguments = args;
								delete currentBlock.partialJson;
							}
							const toolCall = {
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
							hadContent = true;
							const command = getLocalShellCommand(item);
							const args = command ? { cmd: command } : {};
							if (currentBlock?.type === "toolCall") {
								currentBlock.arguments = args;
								delete currentBlock.partialJson;
							}
							const toolCall = {
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
					} else if (event.type === "response.incomplete") {
						const response = asRecord(event.response);
						const details = asRecord(response?.incomplete_details);
						const reason = typeof details?.reason === "string" ? details.reason : "unknown";
						throw new OpenAIResponsesStreamError(`Incomplete response returned, reason: ${reason}`, hadContent);
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
							throw new OpenAIResponsesStreamError(
								`Stream ended with non-terminal status: ${response.status}`,
								hadContent,
							);
						}
						// Map status to stop reason
						output.stopReason = mapStopReason(response?.status);
						if (output.stopReason === "stop" && !output.content.some((b) => b.type === "toolCall")) {
							const recoveredToolCall = recoverToolCallFromTextContent(
								output.content,
								context.tools,
								(name) => normalizeToolName(name, context.tools),
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
						if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
							output.stopReason = "toolUse";
						}
					}
					// Handle errors
					else if (event.type === "error") {
						const code = typeof event.code === "string" ? event.code : undefined;
						const message = typeof event.message === "string" ? event.message : "Unknown error";
						throw new OpenAIResponsesStreamError(code ? `Error Code ${code}: ${message}` : message, hadContent, {
							code,
						});
					} else if (event.type === "response.failed") {
						const response = asRecord(event.response);
						const error = asRecord(event.error) ?? asRecord(response?.error);
						const code = typeof error?.code === "string" ? error.code : undefined;
						const message = typeof error?.message === "string" ? error.message : "OpenAI response failed";
						throw new OpenAIResponsesStreamError(message, hadContent, { code });
					}
				}
				if (!sawCompletion) {
					throw new OpenAIResponsesStreamError(
						hadContent ? "Stream terminated before completion" : "Stream terminated",
						hadContent,
					);
				}
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}
				if (output.stopReason === "aborted" || output.stopReason === "error") {
					throw new Error(output.errorMessage || "OpenAI response failed");
				}
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
				return;
			} catch (error) {
				lastError = error;
				const canRetryWithoutContent =
					error instanceof OpenAIResponsesStreamError &&
					!error.hadContent &&
					isRetryableOpenAIError(error, options?.signal);
				const shouldRetry =
					(!hasEmittedStart || canRetryWithoutContent) &&
					isRetryableOpenAIError(error, options?.signal) &&
					attempt < maxRetries;
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
		if (!hasEmittedStart) {
			stream.push({ type: "start", partial: output });
		}
		for (const block of output.content) delete block.index;
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		const errorMessage = getErrorMessage(lastError ?? "OpenAI response failed");
		output.errorMessage = attempts > 1 ? `${errorMessage} (after ${attempts} attempts)` : errorMessage;
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	})();
	return stream;
};
function createClient(model, apiKey, maxRetries = 0) {
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
		maxRetries,
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
	if (options?.fastMode && isGptFamilyModelId(model.id)) {
		params.service_tier = "priority";
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
function shouldReplayAssistantMessage(msg) {
	return msg.stopReason !== "error" && msg.stopReason !== "aborted";
}
function convertMessages(model, context) {
	const messages = [];
	const replayableToolCallIds = new Set();
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
		const rawCompactItem = getMuCompactResponseItem(msg);
		if (rawCompactItem) {
			messages.push(rawCompactItem);
			continue;
		}
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
			if (!shouldReplayAssistantMessage(msg)) {
				continue;
			}
			const output = [];
			for (const block of msg.content) {
				if (block.type === "thinking") {
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
				} else if (block.type === "toolCall") {
					const toolCall = block;
					replayableToolCallIds.add(toolCall.id);
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
			if (!replayableToolCallIds.has(msg.toolCallId)) {
				continue;
			}
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
