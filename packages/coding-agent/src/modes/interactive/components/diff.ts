import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
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

type RenderedDiffLine = {
	text: string;
	bg?: "toolDiffAddedBg" | "toolDiffRemovedBg";
};

export class DiffText implements Component {
	constructor(
		private readonly diffText: string,
		private readonly options: RenderDiffOptions = {},
	) {}

	render(width: number): string[] {
		return renderDiffLines(this.diffText, this.options).flatMap((line) => renderFullWidthDiffLine(line, width));
	}

	invalidate(): void {}
}

export function createDiffText(diffText: string, options: RenderDiffOptions = {}): DiffText {
	return new DiffText(diffText, options);
}

/**
 * Render a diff string with colored markers and syntax-highlighted content.
 * - Prefixes and line numbers keep diff colors.
 * - Code content uses syntax highlighting when a language can be inferred.
 * - Intra-line word emphasis is intentionally skipped for now.
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	return renderDiffLines(diffText, options)
		.map((line) => line.text)
		.join("\n");
}

function renderDiffLines(diffText: string, options: RenderDiffOptions): RenderedDiffLine[] {
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

	return lines.map((line, index) => renderDiffLine(line, highlightedContent?.[index]));
}

function renderDiffLine(line: string, highlightedContent: string | undefined): RenderedDiffLine {
	const parsed = parseDiffLine(line);
	if (!parsed) return { text: theme.fg("toolDiffContext", line) };

	const content = highlightedContent ?? replaceTabs(parsed.content);
	if (parsed.prefix === "-") {
		return { text: `${theme.fg("toolDiffRemoved", `-${parsed.lineNum} `)}${content}`, bg: "toolDiffRemovedBg" };
	}
	if (parsed.prefix === "+") {
		return { text: `${theme.fg("toolDiffAdded", `+${parsed.lineNum} `)}${content}`, bg: "toolDiffAddedBg" };
	}
	return { text: `${theme.fg("toolDiffContext", ` ${parsed.lineNum} `)}${content}` };
}

function renderFullWidthDiffLine(line: RenderedDiffLine, width: number): string[] {
	if (width <= 0) return [];
	const wrappedLines = wrapTextWithAnsi(line.text, width);
	return wrappedLines.map((wrappedLine) => {
		const paddedLine = padToWidth(wrappedLine, width);
		return line.bg ? theme.bg(line.bg, paddedLine) : paddedLine;
	});
}

function padToWidth(text: string, width: number): string {
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	const remaining = width - visibleWidth(clipped);
	return remaining > 0 ? `${clipped}${" ".repeat(remaining)}` : clipped;
}
