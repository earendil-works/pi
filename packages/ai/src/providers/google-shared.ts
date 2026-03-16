/**
 * Shared utilities for Google Generative AI and Google Gemini CLI providers.
 */

import { type Content, FinishReason, FunctionCallingConfigMode, type Part, type Schema } from "@google/genai";
import type { Context, ImageContent, Model, StopReason, TextContent, Tool, ToolResultMessage } from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transorm-messages.js";

type GoogleApiType = "google-generative-ai" | "google-gemini-cli";

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const transformedMessages = transformMessages(context.messages, model);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				const filteredParts = !model.input.includes("image") ? parts.filter((p) => p.text !== undefined) : parts;
				if (filteredParts.length === 0) continue;
				contents.push({
					role: "user",
					parts: filteredParts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push({ text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					const thinkingPart: Part = {
						thought: true,
						thoughtSignature: block.thinkingSignature,
						text: sanitizeSurrogates(block.thinking),
					};
					parts.push(thinkingPart);
				} else if (block.type === "toolCall") {
					const part: Part = {
						functionCall: {
							id: block.id,
							name: block.name,
							args: block.arguments,
						},
					};
					if (block.thoughtSignature) {
						part.thoughtSignature = block.thoughtSignature;
					}
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Group consecutive tool results into a single turn
			const parts: Part[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// Extract text and image content
				const textContent = toolMsg.content.filter(
					(c: TextContent | ImageContent): c is TextContent => c.type === "text",
				);
				const textResult = textContent.map((c: TextContent) => c.text).join("\n");
				const imageContent = model.input.includes("image")
					? toolMsg.content.filter((c: TextContent | ImageContent): c is ImageContent => c.type === "image")
					: [];

				const hasText = textResult.length > 0;
				const hasImages = imageContent.length > 0;
				const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

				parts.push({
					functionResponse: {
						id: toolMsg.toolCallId,
						name: toolMsg.toolName,
						response: toolMsg.isError ? { error: responseValue } : { output: responseValue },
					},
				});

				// Add any images as inlineData parts
				for (const imageBlock of imageContent) {
					parts.push({
						inlineData: {
							mimeType: imageBlock.mimeType,
							data: imageBlock.data,
						},
					});
				}
				j++;
			}

			contents.push({
				role: "user",
				parts,
			});

			// Skip the grouped tool results
			i = j - 1;
		}
	}

	return contents;
}

/**
 * Convert tools to Gemini function declarations format.
 */
export function convertTools(
	tools: Tool[],
): { functionDeclarations: { name: string; description?: string; parameters: Schema }[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters as Schema,
			})),
		},
	];
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
			return "error";
		default:
			// Unknown finish reasons treated as errors.
			return "error";
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}
