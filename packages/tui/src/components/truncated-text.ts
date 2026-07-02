import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const result: string[] = [];

		// Add vertical padding above (empty lines, not space-padded —
		// the TUI renderer clears lines with \x1b[2K so xterm.js cells
		// stay empty and get trimmed on copy)
		for (let i = 0; i < this.paddingY; i++) {
			result.push("");
		}

		// Calculate available width after horizontal padding
		const availableWidth = Math.max(1, width - this.paddingX * 2);

		// Take only the first line (stop at newline)
		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding
		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// Don't pad to width — the TUI renderer clears each line with
		// \x1b[2K, so trailing spaces are unnecessary. Omitting them keeps
		// xterm.js cells empty, which allows proper whitespace trimming on copy.
		result.push(lineWithPadding);

		// Add vertical padding below
		for (let i = 0; i < this.paddingY; i++) {
			result.push("");
		}

		return result;
	}
}
