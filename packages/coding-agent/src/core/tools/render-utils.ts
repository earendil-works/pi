import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
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

/** Leading lines of a streaming highlight that are re-highlighted with full context on each update. */
const STREAMING_FULL_HIGHLIGHT_PREFIX_LINES = 50;

/** Highlighted display lines of streamed source text, for {@link updateStreamingHighlight}. */
export interface StreamingHighlight {
	source: string;
	language: string | undefined;
	theme: Theme;
	/** Display lines of `source` after normalizeDisplayText and replaceTabs. */
	lines: string[];
	/** Styled version of each entry in `lines`. */
	highlighted: string[];
	/** False when some lines were highlighted one at a time, without multi-line context. */
	exact: boolean;
}

/**
 * Highlight source text that arrives in growing chunks, such as streamed tool arguments.
 *
 * Renderers run on every argument delta, so highlighting the full text each time costs O(n^2) while
 * a long body streams in. When the new source extends the previous one, only the changed last line
 * and new lines are highlighted, one line at a time. The first lines, which collapsed previews show,
 * are re-highlighted with full context. Once `complete` is set, the text is highlighted in full once
 * and then reused until the source, language, or theme changes.
 */
export function updateStreamingHighlight(
	previous: StreamingHighlight | undefined,
	source: string,
	options: {
		language: string | undefined;
		theme: Theme;
		complete: boolean;
		highlight: (code: string) => string[];
	},
): StreamingHighlight {
	const { language, theme, complete, highlight } = options;
	const reusable = previous !== undefined && previous.language === language && previous.theme === theme;
	if (reusable && previous.source === source && (previous.exact || !complete)) return previous;
	if (reusable && !complete && source.startsWith(previous.source)) {
		const highlightLine = (line: string) => highlight(line)[0] ?? "";
		const { lines, highlighted } = previous;
		const added = replaceTabs(normalizeDisplayText(source.slice(previous.source.length))).split("\n");
		const last = lines.length - 1;
		lines[last] += added[0];
		highlighted[last] = highlightLine(lines[last]);
		for (let i = 1; i < added.length; i++) {
			lines.push(added[i]);
			highlighted.push(highlightLine(added[i]));
		}
		const prefixCount = Math.min(STREAMING_FULL_HIGHLIGHT_PREFIX_LINES, lines.length);
		const prefix = highlight(lines.slice(0, prefixCount).join("\n"));
		for (let i = 0; i < prefixCount; i++) highlighted[i] = prefix[i] ?? highlighted[i];
		previous.source = source;
		previous.exact = prefixCount === lines.length;
		return previous;
	}
	const lines = replaceTabs(normalizeDisplayText(source)).split("\n");
	return { source, language, theme, lines, highlighted: highlight(lines.join("\n")), exact: true };
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

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

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
