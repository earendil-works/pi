import * as os from "node:os";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { getCapabilities, getImageDimensions, imageFallback } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../../utils/shell.js";

const MAX_RENDER_OUTPUT_CHARS = 200_000;
const DISPLAY_OUTPUT_TRUNCATED_TEXT = "[display output truncated: too large]";

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

	const outputParts: string[] = [];
	let remainingChars = MAX_RENDER_OUTPUT_CHARS;
	let outputTruncated = false;

	for (const block of textBlocks) {
		if (remainingChars <= 0) {
			outputTruncated = true;
			break;
		}

		const rawText = stripAnsi(block.text || "");
		const rawSlice = rawText.slice(0, remainingChars);
		outputParts.push(sanitizeBinaryOutput(rawSlice).replace(/\r/g, ""));
		remainingChars -= rawSlice.length;

		if (rawSlice.length < rawText.length) {
			outputTruncated = true;
			break;
		}
	}

	let output = outputParts.join("\n");
	if (outputTruncated) {
		output = output ? `${output}\n${DISPLAY_OUTPUT_TRUNCATED_TEXT}` : DISPLAY_OUTPUT_TRUNCATED_TEXT;
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
