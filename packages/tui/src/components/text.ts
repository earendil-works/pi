import type { Component } from "../tui.js";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private customBgFn?: (text: string) => string;

	// Cache for rendered output across the two most recent widths.
	private primaryCachedWidth?: number;
	private primaryCachedLines?: string[];
	private secondaryCachedWidth?: number;
	private secondaryCachedLines?: string[];

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.clearCache();
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		if (customBgFn === this.customBgFn) return;
		this.customBgFn = customBgFn;
		this.clearCache();
	}

	invalidate(): void {
		this.clearCache();
	}

	private clearCache(): void {
		this.primaryCachedWidth = undefined;
		this.primaryCachedLines = undefined;
		this.secondaryCachedWidth = undefined;
		this.secondaryCachedLines = undefined;
	}

	private getCached(width: number): string[] | undefined {
		if (this.primaryCachedWidth === width && this.primaryCachedLines) {
			return this.primaryCachedLines;
		}
		if (this.secondaryCachedWidth === width && this.secondaryCachedLines) {
			const cachedLines = this.secondaryCachedLines;
			this.secondaryCachedWidth = this.primaryCachedWidth;
			this.secondaryCachedLines = this.primaryCachedLines;
			this.primaryCachedWidth = width;
			this.primaryCachedLines = cachedLines;
			return cachedLines;
		}
		return undefined;
	}

	private setCached(width: number, lines: string[]): void {
		if (this.primaryCachedWidth === width) {
			this.primaryCachedLines = lines;
			return;
		}
		this.secondaryCachedWidth = this.primaryCachedWidth;
		this.secondaryCachedLines = this.primaryCachedLines;
		this.primaryCachedWidth = width;
		this.primaryCachedLines = lines;
	}

	render(width: number): string[] {
		const cached = this.getCached(width);
		if (cached) {
			return cached;
		}

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			this.setCached(width, result);
			return result;
		}

		// Replace tabs with 3 spaces
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Calculate content width (subtract left/right margins)
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);

		// Add margins and background to each line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			// Add margins
			const lineWithMargins = leftMargin + line + rightMargin;

			// Apply background if specified (this also pads to full width)
			if (this.customBgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
			} else {
				// No background - just pad to width with spaces
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
			emptyLines.push(line);
		}

		const result = [...emptyLines, ...contentLines, ...emptyLines];

		this.setCached(width, result);

		return result.length > 0 ? result : [""];
	}
}
