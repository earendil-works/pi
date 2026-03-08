import { DEFAULT_CURSOR_STYLE, renderCursorCell } from "../cursor.js";
import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component {
	private value: string = "";
	private cursor: number = 0; // Cursor position in the value
	public onSubmit?: (value: string) => void;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}

	handleInput(data: string): void {
		// Handle bracketed paste mode
		// Start of paste: \x1b[200~
		// End of paste: \x1b[201~

		// Check if we're starting a bracketed paste
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		// If we're in a paste, buffer the data
		if (this.isInPaste) {
			// Check if this chunk contains the end marker
			this.pasteBuffer += data;

			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				// Extract the pasted content
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				// Process the complete paste
				this.handlePaste(pasteContent);

				// Reset paste state
				this.isInPaste = false;

				// Handle any remaining input after the paste marker
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 = length of \x1b[201~
				this.pasteBuffer = "";
				if (remaining) {
					this.handleInput(remaining);
				}
			}
			return;
		}
		// Handle special keys
		if (data === "\r" || data === "\n") {
			// Enter - submit
			if (this.onSubmit) {
				this.onSubmit(this.value);
			}
			return;
		}

		if (data === "\x7f" || data === "\x08") {
			// Backspace
			if (this.cursor > 0) {
				this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor--;
			}
			return;
		}

		if (data === "\x1b[D") {
			// Left arrow
			if (this.cursor > 0) {
				this.cursor--;
			}
			return;
		}

		if (data === "\x1b[C") {
			// Right arrow
			if (this.cursor < this.value.length) {
				this.cursor++;
			}
			return;
		}

		if (data === "\x1b[3~") {
			// Delete
			if (this.cursor < this.value.length) {
				this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
			}
			return;
		}

		if (data === "\x01") {
			// Ctrl+A - beginning of line
			this.cursor = 0;
			return;
		}

		if (data === "\x05") {
			// Ctrl+E - end of line
			this.cursor = this.value.length;
			return;
		}

		// Word left: CSI 1;3D (Option), CSI 1;5D (Ctrl), ESC b (Terminal.app)
		if (data === "\x1b[1;3D" || data === "\x1b[1;5D" || data === "\x1bb") {
			this.moveWordLeft();
			return;
		}

		// Word right: CSI 1;3C (Option), CSI 1;5C (Ctrl), ESC f (Terminal.app)
		if (data === "\x1b[1;3C" || data === "\x1b[1;5C" || data === "\x1bf") {
			this.moveWordRight();
			return;
		}

		// Regular character input
		if (data.length === 1 && data >= " " && data <= "~") {
			this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
			this.cursor++;
		}
	}

	private handlePaste(pastedText: string): void {
		// Clean the pasted text - remove newlines and carriage returns
		const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "");

		// Insert at cursor position
		this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
		this.cursor += cleanText.length;
	}

	/** Word boundaries: whitespace and punctuation. */
	private moveWordLeft(): void {
		if (this.cursor === 0) return;

		const isWhitespace = (char: string): boolean => /\s/.test(char);
		const isPunctuation = (char: string): boolean => /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/.test(char);

		let newCursor = this.cursor;

		while (newCursor > 0 && isWhitespace(this.value[newCursor - 1] ?? "")) newCursor--;

		if (newCursor > 0 && isPunctuation(this.value[newCursor - 1] ?? "")) {
			newCursor--;
		} else {
			while (newCursor > 0) {
				const ch = this.value[newCursor - 1] ?? "";
				if (isWhitespace(ch) || isPunctuation(ch)) break;
				newCursor--;
			}
		}

		this.cursor = newCursor;
	}

	private moveWordRight(): void {
		if (this.cursor >= this.value.length) return;

		const isWhitespace = (char: string): boolean => /\s/.test(char);
		const isPunctuation = (char: string): boolean => /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/.test(char);

		let newCursor = this.cursor;

		if (isPunctuation(this.value[newCursor] ?? "")) {
			newCursor++;
		} else {
			while (newCursor < this.value.length) {
				const ch = this.value[newCursor] ?? "";
				if (isWhitespace(ch) || isPunctuation(ch)) break;
				newCursor++;
			}
		}

		while (newCursor < this.value.length && isWhitespace(this.value[newCursor] ?? "")) newCursor++;

		this.cursor = newCursor;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		// Calculate visible window
		const prompt = "> ";
		const availableWidth = width - prompt.length;

		if (availableWidth <= 0) {
			return [prompt];
		}

		let visibleText = "";
		let cursorDisplay = this.cursor;

		if (this.value.length < availableWidth) {
			// Everything fits (leave room for cursor at end)
			visibleText = this.value;
		} else {
			// Need horizontal scrolling
			// Reserve one character for cursor if it's at the end
			const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			const halfWidth = Math.floor(scrollWidth / 2);

			if (this.cursor < halfWidth) {
				// Cursor near start
				visibleText = this.value.slice(0, scrollWidth);
				cursorDisplay = this.cursor;
			} else if (this.cursor > this.value.length - halfWidth) {
				// Cursor near end
				visibleText = this.value.slice(this.value.length - scrollWidth);
				cursorDisplay = scrollWidth - (this.value.length - this.cursor);
			} else {
				// Cursor in middle
				const start = this.cursor - halfWidth;
				visibleText = this.value.slice(start, start + scrollWidth);
				cursorDisplay = halfWidth;
			}
		}

		// Build line with fake cursor
		// Insert cursor character at cursor position
		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = visibleText[cursorDisplay] || " "; // Character at cursor, or space if at end
		const afterCursor = visibleText.slice(cursorDisplay + 1);

		const cursorChar = renderCursorCell(atCursor, DEFAULT_CURSOR_STYLE);
		const textWithCursor = beforeCursor + cursorChar + afterCursor;

		// Calculate visual width
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + padding;

		return [line];
	}
}
