import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/**
 * Cumulative base64 budget for images kept when recovering from a request-size overflow.
 *
 * Anthropic's hard request limit is 32 MB (HTTP 413 `request_too_large`), independent of the
 * token context window. Images are capped at ~4.5 MB each on the read/file paths, but nothing
 * bounds the *aggregate* across a session, so a transcript with many screenshots can exceed
 * 32 MB while still under the token window. We keep recent images well under the request limit
 * to leave room for text, tool results, and headers.
 */
export const DEFAULT_OVERFLOW_IMAGE_BUDGET_BYTES = 16 * 1024 * 1024;

const DROPPED_IMAGE_PLACEHOLDER = "[older image omitted to recover from a context/request-size overflow]";

function hasImageBearingContent(
	message: AgentMessage,
): message is AgentMessage & { content: (TextContent | ImageContent)[] } {
	return (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content);
}

/**
 * Drop the OLDEST image blocks — replacing each with a short text note — until the cumulative
 * base64 size of the remaining (newest) images is within `budgetBytes`. Text, tool calls, and
 * the most recent images are preserved. Pure: the input is not mutated; a new message array is
 * returned together with the number of images that were replaced.
 *
 * Why this is needed: compaction only summarizes TEXT — it cannot shrink images — so an
 * image-heavy session can stay above Anthropic's 32 MB request limit even after a successful
 * compaction. Without this, context-overflow recovery (compact + retry) fails after a single
 * attempt and the session becomes unusable.
 */
export function capImagesToByteBudget(
	messages: AgentMessage[],
	budgetBytes: number = DEFAULT_OVERFLOW_IMAGE_BUDGET_BYTES,
): { messages: AgentMessage[]; droppedImages: number } {
	// Walk newest-first; keep images while under budget, mark older ones for dropping.
	const toDrop = new Set<ImageContent>();
	let running = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!hasImageBearingContent(message)) continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j];
			if (block.type !== "image") continue;
			const size = block.data.length;
			if (running + size <= budgetBytes) {
				running += size;
			} else {
				toDrop.add(block);
			}
		}
	}

	if (toDrop.size === 0) return { messages, droppedImages: 0 };

	const cappedMessages = messages.map((message): AgentMessage => {
		if (!hasImageBearingContent(message)) return message;
		if (!message.content.some((block) => block.type === "image" && toDrop.has(block))) {
			return message;
		}
		const content = message.content.map((block) =>
			block.type === "image" && toDrop.has(block)
				? ({ type: "text", text: DROPPED_IMAGE_PLACEHOLDER } satisfies TextContent)
				: block,
		);
		return { ...message, content } as AgentMessage;
	});

	return { messages: cappedMessages, droppedImages: toDrop.size };
}
