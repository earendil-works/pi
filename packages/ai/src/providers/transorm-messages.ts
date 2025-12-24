import type { Api, AssistantMessage, Message, Model } from "../types.js";

export function transformMessages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	return messages
		.map((msg) => {
			// User and toolResult messages pass through unchanged
			if (msg.role === "user" || msg.role === "toolResult") {
				return msg;
			}

			// Assistant messages need transformation check
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;

				// If message is from the same provider and API, keep as is
				if (assistantMsg.provider === model.provider && assistantMsg.api === model.api) {
					return msg;
				}

				// Transform message from different provider/model
				const transformedContent = assistantMsg.content.map((block) => {
					if (block.type === "thinking") {
						// Pass thinking block through, but strip signature for cross-provider compatibility
						// (signatures are provider-specific and won't be valid for other providers)
						return {
							type: "thinking" as const,
							thinking: block.thinking,
							thinkingSignature: "",
						};
					}
					// All other blocks (text, toolCall) pass through unchanged
					return block;
				});

				// Return transformed assistant message
				return {
					...assistantMsg,
					content: transformedContent,
				};
			}
			return msg;
		})
		.map((msg, index, allMessages) => {
			// Second pass: filter out tool calls without corresponding tool results
			if (msg.role !== "assistant") {
				return msg;
			}

			const assistantMsg = msg as AssistantMessage;
			const isLastMessage = index === allMessages.length - 1;

			// If this is the last message, keep all tool calls (ongoing turn)
			if (isLastMessage) {
				return msg;
			}

			// Extract tool call IDs from this message
			const toolCallIds = assistantMsg.content
				.filter((block) => block.type === "toolCall")
				.map((block) => (block.type === "toolCall" ? block.id : ""));

			// If no tool calls, return as is
			if (toolCallIds.length === 0) {
				return msg;
			}

			// Scan forward through subsequent messages to find matching tool results
			const matchedToolCallIds = new Set<string>();
			for (let i = index + 1; i < allMessages.length; i++) {
				const nextMsg = allMessages[i];

				// Stop scanning when we hit another assistant message
				if (nextMsg.role === "assistant") {
					break;
				}

				// Check tool result messages for matching IDs
				if (nextMsg.role === "toolResult") {
					matchedToolCallIds.add(nextMsg.toolCallId);
				}
			}

			// Filter out tool calls that don't have corresponding results
			const filteredContent = assistantMsg.content.filter((block) => {
				if (block.type === "toolCall") {
					return matchedToolCallIds.has(block.id);
				}
				return true; // Keep all non-toolCall blocks
			});

			return {
				...assistantMsg,
				content: filteredContent,
			};
		});
}
