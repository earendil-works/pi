/**
 * OpenAI Codex Responses provider.
 * Uses ChatGPT OAuth for API access to GPT-5.x Codex models.
 */
import os from "node:os";
import { calculateCost } from "../models.js";
import { getEnvApiKey } from "../stream.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
	CODEX_BASE_URL,
	JWT_CLAIM_PATH,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
	URL_PATHS,
} from "./openai-codex/constants.js";
import { getCodexInstructions } from "./openai-codex/prompts/codex.js";
import { buildCodexPiBridge } from "./openai-codex/prompts/pi-codex-bridge.js";
import { buildCodexSystemPrompt } from "./openai-codex/prompts/system-prompt.js";
import { transformRequestBody } from "./openai-codex/request-transformer.js";
import { parseCodexError, parseCodexSseStream } from "./openai-codex/response-handler.js";
import { transformMessages } from "./transorm-messages.js";

const CODEX_DEBUG = process.env.PI_CODEX_DEBUG === "1" || process.env.PI_CODEX_DEBUG === "true";
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
		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const accountId = getAccountId(apiKey);
			const baseUrl = model.baseUrl || CODEX_BASE_URL;
			const baseWithSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
			const url = rewriteUrlForCodex(new URL(URL_PATHS.RESPONSES.slice(1), baseWithSlash).toString());
			const messages = convertMessages(model, context);
			const params = {
				model: model.id,
				input: messages,
				stream: true,
				prompt_cache_key: options?.sessionId,
			};
			if (options?.maxTokens) {
				params.max_output_tokens = options.maxTokens;
			}
			if (options?.temperature !== undefined) {
				params.temperature = options.temperature;
			}
			if (context.tools) {
				params.tools = convertTools(context.tools);
			}
			const codexInstructions = getCodexInstructions();
			const bridgeText = buildCodexPiBridge(context.tools);
			const systemPrompt = buildCodexSystemPrompt({
				codexInstructions,
				bridgeText,
				userSystemPrompt: context.systemPrompt,
			});
			params.instructions = systemPrompt.instructions;
			const codexOptions = {
				reasoningEffort: options?.reasoningEffort,
				reasoningSummary: options?.reasoningSummary ?? undefined,
				textVerbosity: options?.textVerbosity,
				include: options?.include,
			};
			const transformedBody = await transformRequestBody(params, codexOptions, systemPrompt);
			const reasoningEffort = transformedBody.reasoning?.effort ?? null;
			const headers = createCodexHeaders(model.headers, accountId, apiKey, options?.sessionId);
			logCodexDebug("codex request", {
				url,
				model: params.model,
				reasoningEffort,
				headers: redactHeaders(headers),
			});
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(transformedBody),
				signal: options?.signal,
			});
			logCodexDebug("codex response", {
				url: response.url,
				status: response.status,
				statusText: response.statusText,
				contentType: response.headers.get("content-type") || null,
				cfRay: response.headers.get("cf-ray") || null,
			});
			if (!response.ok) {
				const info = await parseCodexError(response);
				throw new Error(info.friendlyMessage || info.message);
			}
			if (!response.body) {
				throw new Error("No response body");
			}
			stream.push({ type: "start", partial: output });
			let currentItem = null;
			let currentBlock = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const rawEvent of parseCodexSseStream(response)) {
				const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
				if (!eventType) continue;
				if (eventType === "response.output_item.added") {
					const item = rawEvent.item;
					if (item.type === "reasoning") {
						currentItem = item;
						currentBlock = { type: "thinking", thinking: "" };
						output.content.push(currentBlock);
						stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
					} else if (item.type === "message") {
						currentItem = item;
						currentBlock = { type: "text", text: "" };
						output.content.push(currentBlock);
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					} else if (item.type === "function_call") {
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
				} else if (eventType === "response.reasoning_summary_part.added") {
					if (currentItem && currentItem.type === "reasoning") {
						currentItem.summary = currentItem.summary || [];
						currentItem.summary.push(rawEvent.part);
					}
				} else if (eventType === "response.reasoning_summary_text.delta") {
					if (currentItem && currentItem.type === "reasoning" && currentBlock?.type === "thinking") {
						currentItem.summary = currentItem.summary || [];
						const lastPart = currentItem.summary[currentItem.summary.length - 1];
						if (lastPart) {
							const delta = rawEvent.delta || "";
							currentBlock.thinking += delta;
							lastPart.text += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta,
								partial: output,
							});
						}
					}
				} else if (eventType === "response.reasoning_summary_part.done") {
					if (currentItem && currentItem.type === "reasoning" && currentBlock?.type === "thinking") {
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
				} else if (eventType === "response.content_part.added") {
					if (currentItem && currentItem.type === "message") {
						currentItem.content = currentItem.content || [];
						const part = rawEvent.part;
						if (part && (part.type === "output_text" || part.type === "refusal")) {
							currentItem.content.push(part);
						}
					}
				} else if (eventType === "response.output_text.delta") {
					if (currentItem && currentItem.type === "message" && currentBlock?.type === "text") {
						const lastPart = currentItem.content[currentItem.content.length - 1];
						if (lastPart && lastPart.type === "output_text") {
							const delta = rawEvent.delta || "";
							currentBlock.text += delta;
							lastPart.text += delta;
							stream.push({
								type: "text_delta",
								contentIndex: blockIndex(),
								delta,
								partial: output,
							});
						}
					}
				} else if (eventType === "response.refusal.delta") {
					if (currentItem && currentItem.type === "message" && currentBlock?.type === "text") {
						const lastPart = currentItem.content[currentItem.content.length - 1];
						if (lastPart && lastPart.type === "refusal") {
							const delta = rawEvent.delta || "";
							currentBlock.text += delta;
							lastPart.refusal += delta;
							stream.push({
								type: "text_delta",
								contentIndex: blockIndex(),
								delta,
								partial: output,
							});
						}
					}
				} else if (eventType === "response.function_call_arguments.delta") {
					if (currentItem && currentItem.type === "function_call" && currentBlock?.type === "toolCall") {
						const delta = rawEvent.delta || "";
						currentBlock.partialJson += delta;
						currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta,
							partial: output,
						});
					}
				} else if (eventType === "response.output_item.done") {
					const item = rawEvent.item;
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
						const toolCall = {
							type: "toolCall",
							id: `${item.call_id}|${item.id}`,
							name: item.name,
							arguments: JSON.parse(item.arguments),
						};
						stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
					}
				} else if (eventType === "response.completed" || eventType === "response.done") {
					const response = rawEvent.response;
					if (response?.usage) {
						const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
						output.usage = {
							input: (response.usage.input_tokens || 0) - cachedTokens,
							output: response.usage.output_tokens || 0,
							cacheRead: cachedTokens,
							cacheWrite: 0,
							totalTokens: response.usage.total_tokens || 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
					}
					calculateCost(model, output.usage);
					output.stopReason = mapStopReason(response?.status);
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				} else if (eventType === "error") {
					const code = rawEvent.code || "";
					const message = rawEvent.message || "";
					throw new Error(formatCodexErrorEvent(rawEvent, code, message));
				} else if (eventType === "response.failed") {
					throw new Error(formatCodexFailure(rawEvent) ?? "Codex response failed");
				}
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("Codex response failed");
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
// ============================================================================
// Headers
// ============================================================================
function createCodexHeaders(initHeaders, accountId, accessToken, promptCacheKey) {
	const headers = new Headers(initHeaders ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set("User-Agent", `pi (${os.platform()} ${os.release()}; ${os.arch()})`);
	if (promptCacheKey) {
		headers.set(OPENAI_HEADERS.CONVERSATION_ID, promptCacheKey);
		headers.set(OPENAI_HEADERS.SESSION_ID, promptCacheKey);
	} else {
		headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
		headers.delete(OPENAI_HEADERS.SESSION_ID);
	}
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	return headers;
}
// ============================================================================
// Debug Logging
// ============================================================================
function logCodexDebug(message, details) {
	if (!CODEX_DEBUG) return;
	if (details) {
		console.error(`[codex] ${message}`, details);
		return;
	}
	console.error(`[codex] ${message}`);
}
function redactHeaders(headers) {
	const redacted = {};
	for (const [key, value] of headers.entries()) {
		const lower = key.toLowerCase();
		if (lower === "authorization") {
			redacted[key] = "Bearer [redacted]";
			continue;
		}
		if (
			lower.includes("account") ||
			lower.includes("session") ||
			lower.includes("conversation") ||
			lower === "cookie"
		) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}
// ============================================================================
// URL Rewriting
// ============================================================================
function rewriteUrlForCodex(url) {
	return url.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
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
function getAccountId(accessToken) {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}
	return accountId;
}
// ============================================================================
// Message Conversion
// ============================================================================
function shortHash(str) {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
function convertMessages(model, context) {
	const messages = [];
	const transformedMessages = transformMessages(context.messages, model);
	let msgIndex = 0;
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
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					};
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
				if (block.type === "thinking" && msg.stopReason !== "error") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature);
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block;
					let msgId = textBlock.textSignature;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
					});
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
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c) => c.type === "image");
			const hasText = textResult.length > 0;
			messages.push({
				type: "function_call_output",
				call_id: msg.toolCallId.split("|")[0],
				output: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
			});
			if (hasImages && model.input.includes("image")) {
				const contentParts = [];
				contentParts.push({
					type: "input_text",
					text: "Attached image(s) from tool result:",
				});
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
		msgIndex++;
	}
	return messages;
}
// ============================================================================
// Tool Conversion
// ============================================================================
function convertTools(tools) {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: null,
	}));
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
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default:
			return "stop";
	}
}
// ============================================================================
// Error Formatting
// ============================================================================
function asRecord(value) {
	if (value && typeof value === "object") {
		return value;
	}
	return null;
}
function getString(value) {
	return typeof value === "string" ? value : undefined;
}
function truncate(text, limit) {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}...[truncated ${text.length - limit}]`;
}
function formatCodexFailure(rawEvent) {
	const response = asRecord(rawEvent.response);
	const error = asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);
	const message = getString(error?.message) ?? getString(rawEvent.message) ?? getString(response?.message);
	const code = getString(error?.code) ?? getString(error?.type) ?? getString(rawEvent.code);
	const status = getString(response?.status) ?? getString(rawEvent.status);
	const meta = [];
	if (code) meta.push(`code=${code}`);
	if (status) meta.push(`status=${status}`);
	if (message) {
		const metaText = meta.length ? ` (${meta.join(", ")})` : "";
		return `Codex response failed: ${message}${metaText}`;
	}
	if (meta.length) {
		return `Codex response failed (${meta.join(", ")})`;
	}
	try {
		return `Codex response failed: ${truncate(JSON.stringify(rawEvent), 800)}`;
	} catch {
		return "Codex response failed";
	}
}
function formatCodexErrorEvent(rawEvent, code, message) {
	const detail = formatCodexFailure(rawEvent);
	if (detail) {
		return detail.replace("response failed", "error event");
	}
	const meta = [];
	if (code) meta.push(`code=${code}`);
	if (message) meta.push(`message=${message}`);
	if (meta.length > 0) {
		return `Codex error event (${meta.join(", ")})`;
	}
	try {
		return `Codex error event: ${truncate(JSON.stringify(rawEvent), 800)}`;
	} catch {
		return "Codex error event";
	}
}
//# sourceMappingURL=openai-codex-responses.js.map
