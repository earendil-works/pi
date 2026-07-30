import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { processImage } from "./image-process.ts";

export type ToolResultContent = TextContent | ImageContent;

export interface NormalizeToolResultImagesOptions {
	/** Whether oversized images are resized to inline provider limits. Default: true */
	autoResizeImages?: boolean;
}

/**
 * Normalize image blocks returned by tool results.
 *
 * The `read` tool and `@file` CLI attachments run their images through `processImage`, but tools
 * that produce images themselves (extensions, MCP bridges, screenshot tools) hand back arbitrary
 * base64 payloads that go straight into session history and every subsequent provider request.
 * Oversized images make the provider reject the whole conversation, not just the offending turn,
 * so normalize them once as they enter history.
 *
 * Returns the original array when nothing changed so callers can skip rewriting the result.
 */
export async function normalizeToolResultImages(
	content: ToolResultContent[],
	options?: NormalizeToolResultImagesOptions,
): Promise<ToolResultContent[]> {
	if (!content.some((block) => block.type === "image")) {
		return content;
	}

	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized: ToolResultContent[] = [];
	let changed = false;

	for (const block of content) {
		if (block.type !== "image") {
			normalized.push(block);
			continue;
		}

		const processed = await processImage(Buffer.from(block.data, "base64"), block.mimeType, { autoResizeImages });
		if (!processed.ok) {
			// Unlike `read`, keep the original block. The tool already produced this image and the
			// failure may just be an unavailable image backend, so passing it through preserves the
			// behavior tools have today instead of silently deleting their output.
			normalized.push(block);
			continue;
		}

		if (processed.data === block.data && processed.mimeType === block.mimeType && processed.hints.length === 0) {
			normalized.push(block);
			continue;
		}

		normalized.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		if (processed.hints.length > 0) {
			normalized.push({ type: "text", text: processed.hints.join("\n") });
		}
		changed = true;
	}

	return changed ? normalized : content;
}
