import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { uuidv7 } from "../utils/uuid.ts";
import type { GoogleApiThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReasonString,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface AntigravityOptions extends StreamOptions {
	projectId?: string;
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleApiThinkingLevel;
	};
}

const DEFAULT_CLOUDCODE_URL = "https://daily-cloudcode-pa.googleapis.com";

interface ServerSentEvent {
	event: string | null;
	data: string;
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		if (state.data.length === 0) {
			state.event = null;
			state.raw = [];
			return null;
		}

		const event: ServerSentEvent = {
			event: state.event,
			data: state.data.join("\n"),
		};
		state.event = null;
		state.data = [];
		state.raw = [];
		return event;
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

let toolCallCounter = 0;

export const stream: StreamFunction<"antigravity", AntigravityOptions> = (
	model: Model<"antigravity">,
	context: Context,
	options?: AntigravityOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "antigravity" as Api,
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
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key / token for provider: ${model.provider}`);
			}

			const headerRecord = providerHeadersToRecord(options?.headers) || {};
			const headerValue = (name: string): string | undefined => {
				const lower = name.toLowerCase();
				for (const [key, value] of Object.entries(headerRecord)) {
					if (key.toLowerCase() === lower) return value;
				}
				return undefined;
			};
			const projectId = options?.projectId || headerValue("x-antigravity-project") || "aicode-consumers";

			const contents = convertMessages(model, context);
			const isClaude = model.id.startsWith("claude-");
			const tools = convertTools(context.tools ?? [], isClaude);

			const generationConfig: Record<string, unknown> = {};
			if (options?.temperature !== undefined) {
				generationConfig.temperature = options.temperature;
			}
			if (options?.maxTokens !== undefined) {
				generationConfig.maxOutputTokens = options.maxTokens;
			}
			if (options?.thinking?.enabled) {
				if (options.thinking.level) {
					generationConfig.thinkingConfig = { thinkingLevel: options.thinking.level };
				} else if (options.thinking.budgetTokens !== undefined && options.thinking.budgetTokens > 0) {
					generationConfig.thinkingConfig = { maxThinkingTokens: options.thinking.budgetTokens };
				}
			}

			let payload: Record<string, unknown> = {
				project: projectId,
				requestId: `agent-${uuidv7()}`,
				request: {
					contents,
					...(context.systemPrompt && {
						systemInstruction: { parts: [{ text: sanitizeSurrogates(context.systemPrompt) }] },
					}),
					...(tools && { tools }),
					...(Object.keys(generationConfig).length > 0 && { generationConfig }),
				},
				model: model.id,
				userAgent: "antigravity",
				requestType: "agent",
			};

			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined && typeof nextPayload === "object" && nextPayload !== null) {
				payload = nextPayload as Record<string, unknown>;
			}

			const baseUrl = model.baseUrl || DEFAULT_CLOUDCODE_URL;
			const url = `${baseUrl.replace(/\/+$/, "")}/v1internal:streamGenerateContent?alt=sse`;

			const response = await retryProviderRequest(
				() =>
					fetch(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${apiKey}`,
							"User-Agent": "antigravity/1.21.9 darwin/arm64",
							...headerRecord,
						},
						body: JSON.stringify(payload),
						signal: options?.signal,
					}),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);

			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				const error = new Error(`Antigravity error (${response.status}): ${errorText || response.statusText}`);
				(error as { status?: number }).status = response.status;
				throw error;
			}

			if (!response.body) {
				throw new Error("Antigravity response body is empty");
			}

			stream.push({ type: "start", partial: output });

			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;

			for await (const sse of iterateSseMessages(response.body, options?.signal)) {
				if (!sse.data) continue;

				let data: {
					response?: {
						candidates?: Array<{
							content?: {
								role?: string;
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
							totalTokenCount?: number;
							thoughtsTokenCount?: number;
							cachedContentTokenCount?: number;
						};
					};
				};

				try {
					data = JSON.parse(sse.data);
				} catch {
					continue;
				}

				const candidate = data.response?.candidates?.[0];
				const parts = candidate?.content?.parts;

				if (parts) {
					for (const part of parts) {
						if (isThinkingPart(part)) {
							// Thinking part
							if (!currentBlock || currentBlock.type !== "thinking") {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blockIndex(),
											content: currentBlock.text,
											partial: output,
										});
									}
								}
								currentBlock = {
									type: "thinking",
									thinking: "",
									thinkingSignature: part.thoughtSignature,
								};
								blocks.push(currentBlock);
								stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
							}
							if (part.thoughtSignature) {
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
							}
							if (part.text) {
								currentBlock.thinking += part.text;
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						} else if (part.functionCall) {
							// Tool call part
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else if (currentBlock.type === "thinking") {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							// Generate unique ID if not provided or if it's a duplicate
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
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};
							blocks.push(toolCall);
							stream.push({
								type: "toolcall_start",
								contentIndex: blockIndex(),
								partial: output,
							});
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
						} else if (part.text !== undefined) {
							// Regular text part
							if (!currentBlock || currentBlock.type !== "text") {
								if (currentBlock) {
									if (currentBlock.type === "thinking") {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								currentBlock = {
									type: "text",
									text: "",
									textSignature: part.thoughtSignature,
								};
								blocks.push(currentBlock);
								stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
							}
							if (part.thoughtSignature) {
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
							}
							if (part.text) {
								currentBlock.text += part.text;
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReasonString(candidate.finishReason);
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				if (data.response?.usageMetadata) {
					const usage = data.response.usageMetadata;
					output.usage = {
						input: (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0),
						output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
						cacheRead: usage.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: usage.thoughtsTokenCount || 0,
						totalTokens: usage.totalTokenCount || 0,
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

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else if (currentBlock.type === "thinking") {
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

			if (output.stopReason === "pending") {
				output.stopReason = output.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
			}

			calculateCost(model, output.usage);
			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const normalized = normalizeProviderError(error);
			output.errorMessage = formatProviderError(normalized);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"antigravity", SimpleStreamOptions> = (
	model: Model<"antigravity">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key / token for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies AntigravityOptions;

	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } });
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);
	const level: GoogleApiThinkingLevel =
		resolvedLevel === "minimal"
			? "MINIMAL"
			: resolvedLevel === "low"
				? "LOW"
				: resolvedLevel === "medium"
					? "MEDIUM"
					: "HIGH";

	return stream(model, context, {
		...base,
		thinking: {
			enabled: true,
			level,
		},
	});
};
