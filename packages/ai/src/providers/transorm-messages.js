/**
 * Reorder messages so tool results are adjacent to their parent assistant messages.
 *
 * When user-initiated bash commands interleave with LLM tool calls, toolResult messages
 * can end up separated from their parent assistant message. This violates the Anthropic
 * API requirement that tool_result blocks must immediately follow tool_use blocks.
 *
 * This function "hoists" orphaned toolResults to their correct position while preserving
 * the relative order of other messages.
 *
 * Before: [Assistant(A), User(bash), Assistant(B), Result(B), Result(A)]
 * After:  [Assistant(A), Result(A), User(bash), Assistant(B), Result(B)]
 */
function hoistToolResults(messages) {
    const result = [];
    for (const msg of messages) {
        if (msg.role === "toolResult") {
            const tr = msg;
            let parentIndex = -1;
            // Find parent assistant message in result (searching backwards)
            for (let i = result.length - 1; i >= 0; i--) {
                const m = result[i];
                if (m.role === "assistant") {
                    const am = m;
                    if (am.content.some((c) => c.type === "toolCall" && c.id === tr.toolCallId)) {
                        parentIndex = i;
                        break;
                    }
                }
            }
            if (parentIndex !== -1) {
                // Found parent. Insert after parent and any already-present sibling results.
                let insertPos = parentIndex + 1;
                while (insertPos < result.length && result[insertPos].role === "toolResult") {
                    insertPos++;
                }
                result.splice(insertPos, 0, msg);
            }
            else {
                // No parent found (truncated history or edge case); append normally
                result.push(msg);
            }
        }
        else {
            result.push(msg);
        }
    }
    return result;
}
export function transformMessages(messages, model) {
    // First, hoist orphaned tool results to be adjacent to their parent assistant messages
    const reorderedMessages = hoistToolResults(messages);
    return reorderedMessages
        .map((msg) => {
        // User and toolResult messages pass through unchanged
        if (msg.role === "user" || msg.role === "toolResult") {
            return msg;
        }
        // Assistant messages need transformation check
        if (msg.role === "assistant") {
            const assistantMsg = msg;
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
                        type: "thinking",
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
        const assistantMsg = msg;
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
        const matchedToolCallIds = new Set();
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
//# sourceMappingURL=transorm-messages.js.map