import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { getDiffTheme, getLanguageFromPath, highlightCode } from "../theme/theme.js";

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
	/** Extra columns to fill when rendered inside a padded parent component. */
	extraRightPadding?: number;
}

type RenderedDiffLine = {
	text: string;
	lineStyle?: (text: string) => string;
};

export class DiffText implements Component {
	constructor(
		private readonly diffText: string,
		private readonly options: RenderDiffOptions = {},
	) {}

	render(width: number): string[] {
		const renderWidth = width + (this.options.extraRightPadding ?? 0);
		return renderDiffLines(this.diffText, this.options).flatMap((line) => renderFullWidthDiffLine(line, renderWidth));
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

	const diffTheme = getDiffTheme();
	return lines.map((line, index) => renderDiffLine(line, highlightedContent?.[index], diffTheme));
}

function renderDiffLine(
	line: string,
	highlightedContent: string | undefined,
	diffTheme: ReturnType<typeof getDiffTheme>,
): RenderedDiffLine {
	const parsed = parseDiffLine(line);
	if (!parsed) return { text: diffTheme.contextPrefix(line) };

	const content = highlightedContent ?? replaceTabs(parsed.content);
	if (parsed.prefix === "-") {
		return { text: `${diffTheme.removedPrefix(`-${parsed.lineNum} `)}${content}`, lineStyle: diffTheme.removedLine };
	}
	if (parsed.prefix === "+") {
		return { text: `${diffTheme.addedPrefix(`+${parsed.lineNum} `)}${content}`, lineStyle: diffTheme.addedLine };
	}
	return { text: `${diffTheme.contextPrefix(` ${parsed.lineNum} `)}${content}` };
}

function renderFullWidthDiffLine(line: RenderedDiffLine, width: number): string[] {
	if (width <= 0) return [];
	const wrappedLines = wrapTextWithAnsi(line.text, width);
	return wrappedLines.map((wrappedLine) => {
		const paddedLine = padToWidth(wrappedLine, width);
		return line.lineStyle ? line.lineStyle(paddedLine) : paddedLine;
	});
}

function padToWidth(text: string, width: number): string {
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	const remaining = width - visibleWidth(clipped);
	return remaining > 0 ? `${clipped}${" ".repeat(remaining)}` : clipped;
}
