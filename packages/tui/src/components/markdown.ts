import { marked, type Token, type Tokens } from "marked";
import type { Component } from "../tui.js";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
}

export interface MarkdownOptions {
	/**
	 * If true, render markdown HTML tokens as literal text instead of dropping them.
	 *
	 * By default, HTML tokens are dropped because terminal UIs generally can't
	 * render HTML, and many markdown libraries treat HTML as "raw" blocks.
	 */
	renderHtml?: boolean;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private renderHtml: boolean;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.renderHtml = options?.renderHtml ?? false;
	}

	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Parse markdown to HTML-like tokens
		const tokens = marked.lexer(normalizedText);

		// Convert tokens to styled terminal output
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
			renderedLines.push(...tokenLines);
		}

		// Wrap lines (NO padding, NO background yet)
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
		}

		// Add margins and background to each wrapped line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = [...emptyLines, ...contentLines, ...emptyLines];

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private renderToken(token: Token, width: number, nextTokenType?: string): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = "#".repeat(headingLevel) + " ";
				const headingText = this.renderInlineTokens(token.tokens || []);
				let styledHeading: string;
				if (headingLevel === 1) {
					styledHeading = this.theme.heading(this.theme.bold(this.theme.underline(headingText)));
				} else if (headingLevel === 2) {
					styledHeading = this.theme.heading(this.theme.bold(headingText));
				} else {
					styledHeading = this.theme.heading(this.theme.bold(headingPrefix + headingText));
				}
				lines.push(styledHeading);
				lines.push(""); // Add spacing after headings
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || []);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				lines.push(this.theme.codeBlockBorder("```" + (token.lang || "")));
				// Split code by newlines and style each line
				const codeLines = token.text.split("\n");
				for (const codeLine of codeLines) {
					lines.push("  " + this.theme.codeBlock(codeLine));
				}
				lines.push(this.theme.codeBlockBorder("```"));
				lines.push(""); // Add spacing after code blocks
				break;
			}

			case "list": {
				if (this.isListToken(token)) {
					const listLines = this.renderList(token, 0);
					lines.push(...listLines);
				}
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				if (this.isTableToken(token)) {
					const tableLines = this.renderTable(token);
					lines.push(...tableLines);
				}
				break;
			}

			case "blockquote": {
				const quoteText = this.renderInlineTokens(token.tokens || []);
				const quoteLines = quoteText.split("\n");
				for (const quoteLine of quoteLines) {
					lines.push(this.theme.quoteBorder("│ ") + this.theme.quote(this.theme.italic(quoteLine)));
				}
				lines.push(""); // Add spacing after blockquotes
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				lines.push(""); // Add spacing after horizontal rules
				break;

			case "html":
				// HTML in markdown is treated as "raw" content by many parsers.
				// By default, we drop it (historical behavior), but callers may opt-in
				// to render it as literal text.
				if (this.renderHtml && "text" in token && typeof token.text === "string") {
					for (const htmlLine of token.text.split("\n")) {
						lines.push(this.applyDefaultStyle(htmlLine));
					}
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private isListToken(token: Token): token is Tokens.List {
		return token.type === "list" && Array.isArray((token as Tokens.List).items);
	}

	private isTableToken(token: Token): token is Tokens.Table {
		return token.type === "table" && Array.isArray((token as Tokens.Table).header);
	}

	private renderInlineTokens(tokens: Token[]): string {
		let result = "";

		for (const token of tokens) {
			switch (token.type) {
				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens);
					} else {
						// Apply default style to plain text
						result += this.applyDefaultStyle(token.text);
					}
					break;

				case "strong": {
					// Apply bold, then reapply default style after
					const boldContent = this.renderInlineTokens(token.tokens || []);
					result += this.theme.bold(boldContent) + this.applyDefaultStyle("");
					break;
				}

				case "em": {
					// Apply italic, then reapply default style after
					const italicContent = this.renderInlineTokens(token.tokens || []);
					result += this.theme.italic(italicContent) + this.applyDefaultStyle("");
					break;
				}

				case "codespan":
					// Apply code styling without backticks
					result += this.theme.code(token.text) + this.applyDefaultStyle("");
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || []);
					// If link text matches href, only show the link once
					// Compare raw text (token.text) not styled text (linkText) since linkText has ANSI codes
					if (token.text === token.href) {
						result += this.theme.link(this.theme.underline(linkText)) + this.applyDefaultStyle("");
					} else {
						result +=
							this.theme.link(this.theme.underline(linkText)) +
							this.theme.linkUrl(` (${token.href})`) +
							this.applyDefaultStyle("");
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || []);
					result += this.theme.strikethrough(delContent) + this.applyDefaultStyle("");
					break;
				}

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += this.applyDefaultStyle(token.text);
					}
			}
		}

		return result;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number): string[] {
		const lines: string[] = [];
		const indent = "  ".repeat(depth);

		const startNumber =
			token.ordered && typeof token.start === "number" && Number.isFinite(token.start) ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";

			// Process item tokens to handle nested lists
			const itemLines = this.renderListItem(item.tokens || [], depth);

			if (itemLines.length > 0) {
				// First line - check if it's a nested list
				// A nested list will start with indent (spaces) followed by cyan bullet
				const firstLine = itemLines[0];
				const isNestedList = /^\s+\x1b\[36m[-\d]/.test(firstLine); // starts with spaces + cyan + bullet char

				if (isNestedList) {
					// This is a nested list, just add it as-is (already has full indent)
					lines.push(firstLine);
				} else {
					// Regular text content - add indent and bullet
					lines.push(indent + this.theme.listBullet(bullet) + firstLine);
				}

				// Rest of the lines
				for (let j = 1; j < itemLines.length; j++) {
					const line = itemLines[j];
					const isNestedListLine = /^\s+\x1b\[36m[-\d]/.test(line); // starts with spaces + cyan + bullet char

					if (isNestedListLine) {
						// Nested list line - already has full indent
						lines.push(line);
					} else {
						// Regular content - add parent indent + 2 spaces for continuation
						lines.push(indent + "  " + line);
					}
				}
			} else {
				lines.push(indent + this.theme.listBullet(bullet));
			}
		}

		return lines;
	}

	/**
	 * Render list item tokens, handling nested lists
	 * Returns lines WITHOUT the parent indent (renderList will add it)
	 */
	private renderListItem(tokens: Token[], parentDepth: number): string[] {
		const lines: string[] = [];

		for (const token of tokens) {
			if (this.isListToken(token)) {
				// Nested list - render with one additional indent level
				// These lines will have their own indent, so we just add them as-is
				const nestedLines = this.renderList(token, parentDepth + 1);
				lines.push(...nestedLines);
			} else if (token.type === "text") {
				// Text content (may have inline tokens)
				const text =
					token.tokens && token.tokens.length > 0 ? this.renderInlineTokens(token.tokens) : token.text || "";
				lines.push(text);
			} else if (token.type === "paragraph") {
				// Paragraph in list item
				const text = this.renderInlineTokens(token.tokens || []);
				lines.push(text);
			} else if (token.type === "code") {
				// Code block in list item
				lines.push(this.theme.codeBlockBorder("```" + (token.lang || "")));
				const codeLines = token.text.split("\n");
				for (const codeLine of codeLines) {
					lines.push("  " + this.theme.codeBlock(codeLine));
				}
				lines.push(this.theme.codeBlockBorder("```"));
			} else {
				// Other token types - try to render as inline
				const text = this.renderInlineTokens([token]);
				if (text) {
					lines.push(text);
				}
			}
		}

		return lines;
	}

	/**
	 * Render a table
	 */
	private renderTable(token: Tokens.Table): string[] {
		const lines: string[] = [];

		// Calculate column widths
		const columnWidths: number[] = [];

		// Check header
		for (let i = 0; i < token.header.length; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || []);
			const width = visibleWidth(headerText);
			columnWidths[i] = Math.max(columnWidths[i] || 0, width);
		}

		// Check rows
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || []);
				const width = visibleWidth(cellText);
				columnWidths[i] = Math.max(columnWidths[i] || 0, width);
			}
		}

		// Limit column widths to reasonable max
		const maxColWidth = 40;
		for (let i = 0; i < columnWidths.length; i++) {
			columnWidths[i] = Math.min(columnWidths[i], maxColWidth);
		}

		// Render header
		const headerCells = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || []);
			return this.theme.bold(text.padEnd(columnWidths[i]));
		});
		lines.push("│ " + headerCells.join(" │ ") + " │");

		// Render separator
		const separatorCells = columnWidths.map((width) => "─".repeat(width));
		lines.push("├─" + separatorCells.join("─┼─") + "─┤");

		// Render rows
		for (const row of token.rows) {
			const rowCells = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || []);
				const visWidth = visibleWidth(text);
				const padding = " ".repeat(Math.max(0, columnWidths[i] - visWidth));
				return text + padding;
			});
			lines.push("│ " + rowCells.join(" │ ") + " │");
		}

		lines.push(""); // Add spacing after table
		return lines;
	}
}
