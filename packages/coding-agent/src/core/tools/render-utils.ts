import * as os from "node:os";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { getCapabilities, getImageDimensions, imageFallback } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../../utils/shell.js";

const MAX_RENDER_TEXT_CHARS = 64 * 1024;
const MAX_RENDER_OUTPUT_CHARS = 256 * 1024;
const TRUNCATED_BLOCK_MARKER = "\n[truncated for display]";
const TRUNCATED_TOTAL_MARKER = "\n[truncated total output for display]";

function toSafeString(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value == null) {
		return "";
	}
	try {
		return String(value);
	} catch {
		return "";
	}
}

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = "";
	let totalTruncated = false;
	for (const block of textBlocks) {
		if (totalTruncated) {
			break;
		}

		let text = toSafeString(block.text);
		if (text.length > MAX_RENDER_TEXT_CHARS) {
			text = text.slice(0, MAX_RENDER_TEXT_CHARS) + TRUNCATED_BLOCK_MARKER;
		}

		const sanitized = sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
		const segment = output.length > 0 ? `\n${sanitized}` : sanitized;
		const remaining = MAX_RENDER_OUTPUT_CHARS - output.length;
		if (remaining <= 0) {
			output += TRUNCATED_TOTAL_MARKER;
			totalTruncated = true;
			break;
		}
		if (segment.length > remaining) {
			output += sanitizeBinaryOutput(segment.slice(0, remaining));
			output += TRUNCATED_TOTAL_MARKER;
			totalTruncated = true;
			break;
		}

		output += segment;
	}

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: { fg: (name: any, text: string) => string }): string {
	return theme.fg("error", "[invalid arg]");
}
