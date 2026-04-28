import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export interface RenderDiffOptions {
	/** File path used to infer the syntax highlighting language. */
	filePath?: string;
	/** Called when asynchronous syntax highlighter work completes. */
	invalidate?: () => void;
}

/**
 * Render a diff string with colored markers and syntax-highlighted content.
 * - Prefixes and line numbers keep diff colors.
 * - Code content uses syntax highlighting when a language can be inferred.
 * - Intra-line word emphasis is intentionally skipped for now.
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const lang = options.filePath ? getLanguageFromPath(options.filePath) : undefined;
	const highlightedContent = lang
		? highlightCode(
				lines
					.map((line) => parseDiffLine(line)?.content ?? line)
					.map(replaceTabs)
					.join("\n"),
				lang,
				options.invalidate,
			)
		: undefined;

	return lines.map((line, index) => renderDiffLine(line, highlightedContent?.[index])).join("\n");
}

function renderDiffLine(line: string, highlightedContent: string | undefined): string {
	const parsed = parseDiffLine(line);
	if (!parsed) return theme.fg("toolDiffContext", line);

	const content = highlightedContent ?? replaceTabs(parsed.content);
	if (parsed.prefix === "-") {
		return `${theme.fg("toolDiffRemoved", `-${parsed.lineNum} `)}${content}`;
	}
	if (parsed.prefix === "+") {
		return `${theme.fg("toolDiffAdded", `+${parsed.lineNum} `)}${content}`;
	}
	return `${theme.fg("toolDiffContext", ` ${parsed.lineNum} `)}${content}`;
}
