/**
 * Minimal TUI implementation with differential rendering
 */

import type { Terminal } from "./terminal.js";
import { visibleWidth } from "./utils.js";

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

export { visibleWidth };

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	private terminal: Terminal;
	private previousLines: string[] = [];
	private previousWidth = 0;
	private focusedComponent: Component | null = null;
	private renderRequested = false;
	private cursorRow = 0; // Track where cursor is (0-indexed, relative to our first line)

	constructor(terminal: Terminal) {
		super();
		this.terminal = terminal;
	}

	setFocus(component: Component | null): void {
		this.focusedComponent = component;
	}

	start(): void {
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.requestRender();
	}

	stop(): void {
		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(): void {
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => {
			this.renderRequested = false;
			this.doRender();
		});
	}

	private handleInput(data: string): void {
		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	private doRender(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// Render all components to get new lines
		const newLines = this.render(width);

		// Width changed - need full re-render
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;

		// First render - just output everything without clearing
		if (this.previousLines.length === 0) {
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			// After rendering N lines, cursor is at end of last line (line N-1)
			this.cursorRow = newLines.length - 1;
			this.previousLines = newLines;
			this.previousWidth = width;
			return;
		}

		// Width changed - full re-render
		if (widthChanged) {
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			buffer += "\x1b[3J\x1b[2J\x1b[H"; // Clear scrollback, screen, and home
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = newLines.length - 1;
			this.previousLines = newLines;
			this.previousWidth = width;
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
			}
		}

		// No changes
		if (firstChanged === -1) {
			return;
		}

		// Special case: appended lines must be committed to scrollback.
		// Terminals generally do NOT scroll when you "move down" with cursor controls.
		// They scroll when you actually output newlines at the bottom.
		const appendedLines = newLines.length > this.previousLines.length;
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// Check if firstChanged is outside the viewport
		// cursorRow is the line where cursor is (0-indexed)
		// Viewport shows lines from (cursorRow - height + 1) to cursorRow
		// If firstChanged < viewportTop, we need full re-render
		const viewportTop = this.cursorRow - height + 1;
		if (firstChanged < viewportTop) {
			// First change is above viewport - need full re-render
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			buffer += "\x1b[3J\x1b[2J\x1b[H"; // Clear scrollback, screen, and home
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = newLines.length - 1;
			this.previousLines = newLines;
			this.previousWidth = width;
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output

		// Move cursor to first changed line.
		// If we're appending at the end, move to the last existing line and emit a newline
		// so the terminal scrolls and the new content is added below.
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		const lineDiff = moveTargetRow - this.cursorRow;
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0 (and scroll if appending)

		// Render from first changed line to end, clearing each line before writing
		// This avoids the \x1b[J clear-to-end which can cause flicker in xterm.js
		for (let i = firstChanged; i < newLines.length; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // Clear current line
			if (visibleWidth(newLines[i]) > width) {
				throw new Error(`Rendered line ${i} exceeds terminal width\n\n${newLines[i]}`);
			}
			buffer += newLines[i];
		}

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Cursor is now at end of last line
		this.cursorRow = newLines.length - 1;

		this.previousLines = newLines;
		this.previousWidth = width;
	}
}
