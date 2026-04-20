import type { Context, ImageContent, Message, StreamOptions } from "../types.js";

/**
 * Apply the `optimizeImage` callback from StreamOptions to all ImageContent
 * blocks in the context messages. Returns a new Context with optimized images
 * if any were transformed, or the original context if nothing changed.
 */
export async function optimizeContextImages(context: Context, options?: StreamOptions): Promise<Context> {
	const optimizer = options?.optimizeImage;
	if (!optimizer) return context;

	let changed = false;
	const optimizedMessages: Message[] = [];

	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				optimizedMessages.push(msg);
				continue;
			}
			const optimizedContent = await optimizeContentArray(msg.content, optimizer);
			if (optimizedContent !== msg.content) {
				optimizedMessages.push({ ...msg, content: optimizedContent });
				changed = true;
			} else {
				optimizedMessages.push(msg);
			}
		} else if (msg.role === "toolResult") {
			const optimizedContent = await optimizeContentArray(msg.content, optimizer);
			if (optimizedContent !== msg.content) {
				optimizedMessages.push({ ...msg, content: optimizedContent });
				changed = true;
			} else {
				optimizedMessages.push(msg);
			}
		} else {
			optimizedMessages.push(msg);
		}
	}

	if (!changed) return context;
	return { ...context, messages: optimizedMessages };
}

type ContentItem = { type: "text"; text: string } | ImageContent;

async function optimizeContentArray(
	content: ContentItem[],
	optimizer: (image: ImageContent) => ImageContent | Promise<ImageContent>,
): Promise<ContentItem[]> {
	let changed = false;
	const result: ContentItem[] = [];

	for (const item of content) {
		if (item.type === "image") {
			const optimized = await optimizer(item);
			if (optimized !== item) {
				changed = true;
			}
			result.push(optimized);
		} else {
			result.push(item);
		}
	}

	return changed ? result : content;
}
