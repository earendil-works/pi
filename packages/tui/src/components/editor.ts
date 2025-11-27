import type { AutocompleteProvider, CombinedAutocompleteProvider } from "../autocomplete.js";
import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";
import { SelectList, type SelectListTheme } from "./select-list.js";

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

/** Maps a wrapped display line to its buffer position. endCol is exclusive. */
interface DisplaySlice {
	text: string;
	bufferLine: number;
	startCol: number;
	endCol: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}

export class Editor implements Component {
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	private theme: EditorTheme;

	// Border color (can be changed dynamically)
	public borderColor: (str: string) => string;

	// Autocomplete support
	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteList?: SelectList;
	private isAutocompleting: boolean = false;
	private autocompletePrefix: string = "";

	// Paste tracking for large pastes
	private pastes: Map<number, string> = new Map();
	private pasteCounter: number = 0;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	private displaySlices: DisplaySlice[] = [];
	private lastRenderWidth: number = 0;
	private targetDisplayCol: number | undefined = undefined; // preserved across vertical moves

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	constructor(theme: EditorTheme) {
		this.theme = theme;
		this.borderColor = theme.borderColor;
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.autocompleteProvider = provider;
	}

	invalidate(): void {
		this.displaySlices = [];
		this.lastRenderWidth = 0;
		this.targetDisplayCol = undefined;
	}

	render(width: number): string[] {
		const horizontal = this.borderColor("─");

		this.lastRenderWidth = width;
		const layoutLines = this.layoutText(width);

		const result: string[] = [];

		// Render top border
		result.push(horizontal.repeat(width));

		// Render each layout line
		for (const layoutLine of layoutLines) {
			let displayText = layoutLine.text;
			let visLen = visibleWidth(layoutLine.text);

			// Add cursor if this line has it
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				if (after.length > 0) {
					const cursor = `\x1b[7m${after[0]}\x1b[0m`;
					const restAfter = after.slice(1);
					displayText = before + cursor + restAfter;
				} else {
					if (visLen < width) {
						const cursor = "\x1b[7m \x1b[0m";
						displayText = before + cursor;
						visLen = visLen + 1;
					} else if (before.length > 0) {
						// No room for cursor space; highlight last char instead
						const lastChar = before[before.length - 1];
						const cursor = `\x1b[7m${lastChar}\x1b[0m`;
						displayText = before.slice(0, -1) + cursor;
					}
				}
			}

			// Calculate padding based on actual visible length
			const padding = " ".repeat(Math.max(0, width - visLen));

			// Render the line (no side borders, just horizontal lines above and below)
			result.push(displayText + padding);
		}

		// Render bottom border
		result.push(horizontal.repeat(width));

		// Add autocomplete list if active
		if (this.isAutocompleting && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(width);
			result.push(...autocompleteResult);
		}

		return result;
	}

	handleInput(data: string): void {
		// Handle bracketed paste mode
		// Start of paste: \x1b[200~
		// End of paste: \x1b[201~

		// Check if we're starting a bracketed paste
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			// Remove the start marker and keep the rest
			data = data.replace("\x1b[200~", "");
		}

		// If we're in a paste, buffer the data
		if (this.isInPaste) {
			// Append data to buffer first (end marker could be split across chunks)
			this.pasteBuffer += data;

			// Check if the accumulated buffer contains the end marker
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				// Extract content before the end marker
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				// Process the complete paste
				this.handlePaste(pasteContent);

				// Reset paste state
				this.isInPaste = false;

				// Process any remaining data after the end marker
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 = length of \x1b[201~
				this.pasteBuffer = "";

				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			} else {
				// Still accumulating, wait for more data
				return;
			}
		}

		// Handle special key combinations first

		// Ctrl+C - Exit (let parent handle this)
		if (data.charCodeAt(0) === 3) {
			return;
		}

		// Handle autocomplete special keys first (but don't block other input)
		if (this.isAutocompleting && this.autocompleteList) {
			// Escape - cancel autocomplete
			if (data === "\x1b") {
				this.cancelAutocomplete();
				return;
			}
			// Let the autocomplete list handle navigation and selection
			else if (data === "\x1b[A" || data === "\x1b[B" || data === "\r" || data === "\t") {
				// Only pass arrow keys to the list, not Enter/Tab (we handle those directly)
				if (data === "\x1b[A" || data === "\x1b[B") {
					this.autocompleteList.handleInput(data);
					return;
				}

				// If Tab was pressed, always apply the selection
				if (data === "\t") {
					const selected = this.autocompleteList.getSelectedItem();
					if (selected && this.autocompleteProvider) {
						const result = this.autocompleteProvider.applyCompletion(
							this.state.lines,
							this.state.cursorLine,
							this.state.cursorCol,
							selected,
							this.autocompletePrefix,
						);

						this.state.lines = result.lines;
						this.state.cursorLine = result.cursorLine;
						this.state.cursorCol = result.cursorCol;

						this.cancelAutocomplete();

						if (this.onChange) {
							this.onChange(this.getText());
						}
					}
					return;
				}

				// If Enter was pressed on a slash command, apply completion and submit
				if (data === "\r" && this.autocompletePrefix.startsWith("/")) {
					const selected = this.autocompleteList.getSelectedItem();
					if (selected && this.autocompleteProvider) {
						const result = this.autocompleteProvider.applyCompletion(
							this.state.lines,
							this.state.cursorLine,
							this.state.cursorCol,
							selected,
							this.autocompletePrefix,
						);

						this.state.lines = result.lines;
						this.state.cursorLine = result.cursorLine;
						this.state.cursorCol = result.cursorCol;
					}
					this.cancelAutocomplete();
					// Don't return - fall through to submission logic
				}
				// If Enter was pressed on a file path, apply completion
				else if (data === "\r") {
					const selected = this.autocompleteList.getSelectedItem();
					if (selected && this.autocompleteProvider) {
						const result = this.autocompleteProvider.applyCompletion(
							this.state.lines,
							this.state.cursorLine,
							this.state.cursorCol,
							selected,
							this.autocompletePrefix,
						);

						this.state.lines = result.lines;
						this.state.cursorLine = result.cursorLine;
						this.state.cursorCol = result.cursorCol;

						this.cancelAutocomplete();

						if (this.onChange) {
							this.onChange(this.getText());
						}
					}
					return;
				}
			}
			// For other keys (like regular typing), DON'T return here
			// Let them fall through to normal character handling
		}

		// Tab key - context-aware completion (but not when already autocompleting)
		if (data === "\t" && !this.isAutocompleting) {
			this.handleTabCompletion();
			return;
		}

		// Continue with rest of input handling
		// Ctrl+K - Delete to end of line
		if (data.charCodeAt(0) === 11) {
			this.deleteToEndOfLine();
		}
		// Ctrl+U - Delete to start of line
		else if (data.charCodeAt(0) === 21) {
			this.deleteToStartOfLine();
		}
		// Ctrl+W - Delete word backwards
		else if (data.charCodeAt(0) === 23) {
			this.deleteWordBackwards();
		}
		// Option/Alt+Backspace (e.g. Ghostty sends ESC + DEL)
		else if (data === "\x1b\x7f") {
			this.deleteWordBackwards();
		}
		// Word left: CSI 1;3D (Option), CSI 1;5D (Ctrl), ESC b (Terminal.app)
		else if (data === "\x1b[1;3D" || data === "\x1b[1;5D" || data === "\x1bb") {
			this.moveWordLeft();
		}
		// Word right: CSI 1;3C (Option), CSI 1;5C (Ctrl), ESC f (Terminal.app)
		else if (data === "\x1b[1;3C" || data === "\x1b[1;5C" || data === "\x1bf") {
			this.moveWordRight();
		}
		// Ctrl+A - Move to start of line
		else if (data.charCodeAt(0) === 1) {
			this.moveToLineStart();
		}
		// Ctrl+E - Move to end of line
		else if (data.charCodeAt(0) === 5) {
			this.moveToLineEnd();
		}
		// New line shortcuts (but not plain LF/CR which should be submit)
		else if (
			(data.charCodeAt(0) === 10 && data.length > 1) || // Ctrl+Enter with modifiers
			data === "\x1b\r" || // Option+Enter in some terminals
			data === "\x1b[13;2~" || // Shift+Enter in some terminals
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1) || // Shift+Enter from iTerm2 mapping
			data === "\\\r" // Shift+Enter in VS Code terminal
		) {
			// Modifier + Enter = new line
			this.addNewLine();
		}
		// Plain Enter (char code 13 for CR) - only CR submits, LF adds new line
		else if (data.charCodeAt(0) === 13 && data.length === 1) {
			// If submit is disabled, do nothing
			if (this.disableSubmit) {
				return;
			}

			// Get text and substitute paste markers with actual content
			let result = this.state.lines.join("\n").trim();

			// Replace all [paste #N +xxx lines] or [paste #N xxx chars] markers with actual paste content
			for (const [pasteId, pasteContent] of this.pastes) {
				// Match formats: [paste #N], [paste #N +xxx lines], or [paste #N xxx chars]
				const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
				result = result.replace(markerRegex, pasteContent);
			}

			// Reset editor and clear pastes
			this.state = {
				lines: [""],
				cursorLine: 0,
				cursorCol: 0,
			};
			this.pastes.clear();
			this.pasteCounter = 0;

			// Notify that editor is now empty
			if (this.onChange) {
				this.onChange("");
			}

			if (this.onSubmit) {
				this.onSubmit(result);
			}
		}
		// Backspace
		else if (data.charCodeAt(0) === 127 || data.charCodeAt(0) === 8) {
			this.handleBackspace();
		}
		// Line navigation shortcuts (Home/End keys)
		else if (data === "\x1b[H" || data === "\x1b[1~" || data === "\x1b[7~") {
			// Home key
			this.moveToLineStart();
		} else if (data === "\x1b[F" || data === "\x1b[4~" || data === "\x1b[8~") {
			// End key
			this.moveToLineEnd();
		}
		// Forward delete (Fn+Backspace or Delete key)
		else if (data === "\x1b[3~") {
			// Delete key
			this.handleForwardDelete();
		}
		// Arrow keys
		else if (data === "\x1b[A") {
			// Up
			this.moveCursor(-1, 0);
		} else if (data === "\x1b[B") {
			// Down
			this.moveCursor(1, 0);
		} else if (data === "\x1b[C") {
			// Right
			this.moveCursor(0, 1);
		} else if (data === "\x1b[D") {
			// Left
			this.moveCursor(0, -1);
		}
		// Regular characters (printable characters and unicode, but not control characters)
		else if (data.charCodeAt(0) >= 32) {
			this.insertCharacter(data);
		}
	}

	private layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];
		this.displaySlices = [];

		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			layoutLines.push({ text: "", hasCursor: true, cursorPos: 0 });
			this.displaySlices.push({ text: "", bufferLine: 0, startCol: 0, endCol: 0 });
			return layoutLines;
		}

		for (let bufferLine = 0; bufferLine < this.state.lines.length; bufferLine++) {
			const line = this.state.lines[bufferLine] || "";
			const isCurrentLine = bufferLine === this.state.cursorLine;
			const lineVisibleWidth = visibleWidth(line);

			if (lineVisibleWidth <= contentWidth) {
				const hasCursor = isCurrentLine;
				const cursorDisplayCol = hasCursor ? this.state.cursorCol : undefined;

				layoutLines.push({ text: line, hasCursor, cursorPos: cursorDisplayCol });
				this.displaySlices.push({ text: line, bufferLine, startCol: 0, endCol: line.length });
			} else {
				const slices = this.wrapLineByVisibleWidth(line, contentWidth);

				for (let sliceIdx = 0; sliceIdx < slices.length; sliceIdx++) {
					const slice = slices[sliceIdx];
					const isLastSlice = sliceIdx === slices.length - 1;

					// Non-last slices use exclusive end; last slice includes end-of-line cursor position
					let hasCursorInSlice = false;
					if (isCurrentLine && this.state.cursorCol >= slice.startCol) {
						hasCursorInSlice = isLastSlice
							? this.state.cursorCol <= slice.endCol
							: this.state.cursorCol < slice.endCol;
					}

					const cursorDisplayCol = hasCursorInSlice ? this.state.cursorCol - slice.startCol : undefined;

					layoutLines.push({ text: slice.text, hasCursor: hasCursorInSlice, cursorPos: cursorDisplayCol });
					this.displaySlices.push({
						text: slice.text,
						bufferLine,
						startCol: slice.startCol,
						endCol: slice.endCol,
					});
				}
			}
		}

		return layoutLines;
	}

	/** Wrap line by visible width (character-based, breaks at width boundary). */
	private wrapLineByVisibleWidth(
		line: string,
		maxWidth: number,
	): Array<{ text: string; startCol: number; endCol: number }> {
		const result: Array<{ text: string; startCol: number; endCol: number }> = [];
		let currentSliceStart = 0;
		let currentSliceText = "";
		let currentWidth = 0;

		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			const charWidth = visibleWidth(char);

			if (currentWidth + charWidth > maxWidth && currentSliceText.length > 0) {
				result.push({ text: currentSliceText, startCol: currentSliceStart, endCol: i });
				currentSliceStart = i;
				currentSliceText = "";
				currentWidth = 0;
			}

			currentSliceText += char;
			currentWidth += charWidth;
		}

		if (currentSliceText.length > 0 || result.length === 0) {
			result.push({ text: currentSliceText, startCol: currentSliceStart, endCol: line.length });
		}

		return result;
	}

	getText(): string {
		return this.state.lines.join("\n");
	}

	setText(text: string): void {
		const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = this.state.lines.length - 1;
		this.state.cursorCol = this.state.lines[this.state.cursorLine]?.length || 0;
		this.targetDisplayCol = undefined;

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private clearTargetColumn(): void {
		this.targetDisplayCol = undefined;
	}

	private insertCharacter(char: string): void {
		const line = this.state.lines[this.state.cursorLine] || "";
		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.state.cursorCol += char.length;
		this.clearTargetColumn();

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Check if we should trigger or update autocomplete
		if (!this.isAutocompleting) {
			// Auto-trigger for "/" at the start of a line (slash commands)
			if (char === "/" && this.isAtStartOfMessage()) {
				this.tryTriggerAutocomplete();
			}
			// Auto-trigger for "@" file reference (fuzzy search)
			else if (char === "@") {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// Only trigger if @ is after whitespace or at start of line
				const charBeforeAt = textBeforeCursor[textBeforeCursor.length - 2];
				if (textBeforeCursor.length === 1 || charBeforeAt === " " || charBeforeAt === "\t") {
					this.tryTriggerAutocomplete();
				}
			}
			// Also auto-trigger when typing letters in a slash command context
			else if (/[a-zA-Z0-9]/.test(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// Check if we're in a slash command (with or without space for arguments)
				if (textBeforeCursor.trimStart().startsWith("/")) {
					this.tryTriggerAutocomplete();
				}
				// Check if we're in an @ file reference context
				else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
					this.tryTriggerAutocomplete();
				}
			}
		} else {
			this.updateAutocomplete();
		}
	}

	private handlePaste(pastedText: string): void {
		// Clean the pasted text
		const cleanText = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Convert tabs to spaces (4 spaces per tab)
		const tabExpandedText = cleanText.replace(/\t/g, "    ");

		// Filter out non-printable characters except newlines
		const filteredText = tabExpandedText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");

		// Split into lines
		const pastedLines = filteredText.split("\n");

		// Check if this is a large paste (> 10 lines or > 1000 characters)
		const totalChars = filteredText.length;
		if (pastedLines.length > 10 || totalChars > 1000) {
			// Store the paste and insert a marker
			this.pasteCounter++;
			const pasteId = this.pasteCounter;
			this.pastes.set(pasteId, filteredText);

			// Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
			const marker =
				pastedLines.length > 10
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			for (const char of marker) {
				this.insertCharacter(char);
			}

			return;
		}

		if (pastedLines.length === 1) {
			// Single line - just insert each character
			const text = pastedLines[0] || "";
			for (const char of text) {
				this.insertCharacter(char);
			}

			return;
		}

		// Multi-line paste - be very careful with array manipulation
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		// Build the new lines array step by step
		const newLines: string[] = [];

		// Add all lines before current line
		for (let i = 0; i < this.state.cursorLine; i++) {
			newLines.push(this.state.lines[i] || "");
		}

		// Add the first pasted line merged with before cursor text
		newLines.push(beforeCursor + (pastedLines[0] || ""));

		// Add all middle pasted lines
		for (let i = 1; i < pastedLines.length - 1; i++) {
			newLines.push(pastedLines[i] || "");
		}

		// Add the last pasted line with after cursor text
		newLines.push((pastedLines[pastedLines.length - 1] || "") + afterCursor);

		// Add all lines after current line
		for (let i = this.state.cursorLine + 1; i < this.state.lines.length; i++) {
			newLines.push(this.state.lines[i] || "");
		}

		// Replace the entire lines array
		this.state.lines = newLines;

		// Update cursor position to end of pasted content
		this.state.cursorLine += pastedLines.length - 1;
		this.state.cursorCol = (pastedLines[pastedLines.length - 1] || "").length;

		this.clearTargetColumn();

		// Notify of change
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private addNewLine(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		// Split current line
		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		// Move cursor to start of new line
		this.state.cursorLine++;
		this.state.cursorCol = 0;

		this.clearTargetColumn();

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private handleBackspace(): void {
		if (this.state.cursorCol > 0) {
			// Delete character in current line
			const line = this.state.lines[this.state.cursorLine] || "";

			const before = line.slice(0, this.state.cursorCol - 1);
			const after = line.slice(this.state.cursorCol);

			this.state.lines[this.state.cursorLine] = before + after;
			this.state.cursorCol--;
		} else if (this.state.cursorLine > 0) {
			// Merge with previous line
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			this.state.cursorLine--;
			this.state.cursorCol = previousLine.length;
		}

		this.clearTargetColumn();

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after backspace
		if (this.isAutocompleting) {
			this.updateAutocomplete();
		} else {
			// If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			if (textBeforeCursor.trimStart().startsWith("/")) {
				this.tryTriggerAutocomplete();
			}
			// @ file reference context
			else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	private moveToLineStart(): void {
		this.state.cursorCol = 0;
		this.clearTargetColumn();
	}

	private moveToLineEnd(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.state.cursorCol = currentLine.length;
		this.clearTargetColumn();
	}

	private deleteToStartOfLine(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol > 0) {
			// Delete from start of line up to cursor
			this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
			this.state.cursorCol = 0;
		} else if (this.state.cursorLine > 0) {
			// At start of line - merge with previous line
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.state.cursorCol = previousLine.length;
		}

		this.clearTargetColumn();

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteToEndOfLine(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			// Delete from cursor to end of line
			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			// At end of line - merge with next line
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		this.clearTargetColumn();

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordBackwards(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, behave like backspace at column 0 (merge with previous line)
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
				this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
				this.state.lines.splice(this.state.cursorLine, 1);
				this.state.cursorLine--;
				this.state.cursorCol = previousLine.length;
			}
		} else {
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);

			const isWhitespace = (char: string): boolean => /\s/.test(char);
			const isPunctuation = (char: string): boolean => {
				// Treat obvious code punctuation as boundaries
				return /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/.test(char);
			};

			let deleteFrom = this.state.cursorCol;
			const lastChar = textBeforeCursor[deleteFrom - 1] ?? "";

			// If immediately on whitespace or punctuation, delete that single boundary char
			if (isWhitespace(lastChar) || isPunctuation(lastChar)) {
				deleteFrom -= 1;
			} else {
				// Otherwise, delete a run of non-boundary characters (the "word")
				while (deleteFrom > 0) {
					const ch = textBeforeCursor[deleteFrom - 1] ?? "";
					if (isWhitespace(ch) || isPunctuation(ch)) {
						break;
					}
					deleteFrom -= 1;
				}
			}

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
			this.state.cursorCol = deleteFrom;
		}

		this.clearTargetColumn();

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private handleForwardDelete(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			// Delete character at cursor position (forward delete)
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + 1);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			// At end of line - merge with next line
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		this.clearTargetColumn();

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after forward delete
		if (this.isAutocompleting) {
			this.updateAutocomplete();
		} else {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			if (textBeforeCursor.trimStart().startsWith("/")) {
				this.tryTriggerAutocomplete();
			}
			// @ file reference context
			else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/** Display-line-aware cursor movement. Falls back to logical if no layout exists. */
	private moveCursor(deltaLine: number, deltaCol: number): void {
		if (this.displaySlices.length === 0 || this.lastRenderWidth === 0) {
			this.moveCursorLogical(deltaLine, deltaCol);
			return;
		}
		if (deltaLine !== 0) this.moveCursorVertical(deltaLine);
		if (deltaCol !== 0) this.moveCursorHorizontal(deltaCol);
	}

	private moveCursorLogical(deltaLine: number, deltaCol: number): void {
		if (deltaLine !== 0) {
			const newLine = this.state.cursorLine + deltaLine;
			if (newLine >= 0 && newLine < this.state.lines.length) {
				this.state.cursorLine = newLine;
				const line = this.state.lines[this.state.cursorLine] || "";
				this.state.cursorCol = Math.min(this.state.cursorCol, line.length);
			}
		}

		if (deltaCol !== 0) {
			const newCol = this.state.cursorCol + deltaCol;
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const maxCol = currentLine.length;
			this.state.cursorCol = Math.max(0, Math.min(maxCol, newCol));
		}
	}

	/** Cursor at slice boundary belongs to NEXT slice, unless at end of buffer line. */
	private findCurrentDisplayLine(): number {
		const bufferLine = this.state.cursorLine;
		const cursorCol = this.state.cursorCol;

		const slicesForLine: number[] = [];
		for (let i = 0; i < this.displaySlices.length; i++) {
			if (this.displaySlices[i].bufferLine === bufferLine) {
				slicesForLine.push(i);
			}
		}
		if (slicesForLine.length === 0) return 0;

		for (const idx of slicesForLine) {
			const slice = this.displaySlices[idx];
			const isLastSliceForLine = idx === slicesForLine[slicesForLine.length - 1];
			if (cursorCol >= slice.startCol) {
				if (isLastSliceForLine && cursorCol <= slice.endCol) return idx;
				if (!isLastSliceForLine && cursorCol < slice.endCol) return idx;
			}
		}

		return slicesForLine[slicesForLine.length - 1];
	}

	private moveCursorVertical(delta: number): void {
		const currentDisplayLine = this.findCurrentDisplayLine();
		const currentSlice = this.displaySlices[currentDisplayLine];
		const currentDisplayCol = this.state.cursorCol - currentSlice.startCol;

		if (this.targetDisplayCol === undefined) {
			this.targetDisplayCol = currentDisplayCol;
		}

		const newDisplayLine = currentDisplayLine + delta;
		if (newDisplayLine < 0 || newDisplayLine >= this.displaySlices.length) return;

		const newSlice = this.displaySlices[newDisplayLine];
		const sliceLength = newSlice.endCol - newSlice.startCol;

		// Clamp to sliceLength-1 for non-last slices to avoid landing on wrap boundary
		const isLastSliceForLine =
			newDisplayLine === this.displaySlices.length - 1 ||
			this.displaySlices[newDisplayLine + 1].bufferLine !== newSlice.bufferLine;
		const maxCol = isLastSliceForLine ? sliceLength : Math.max(0, sliceLength - 1);
		const targetCol = Math.min(this.targetDisplayCol, maxCol);

		this.state.cursorLine = newSlice.bufferLine;
		this.state.cursorCol = newSlice.startCol + targetCol;
	}

	private moveCursorHorizontal(delta: number): void {
		this.targetDisplayCol = undefined;
		const currentDisplayLine = this.findCurrentDisplayLine();
		const currentSlice = this.displaySlices[currentDisplayLine];

		if (delta < 0) {
			if (this.state.cursorCol > currentSlice.startCol) {
				this.state.cursorCol += delta;
			} else if (currentDisplayLine > 0) {
				const prevSlice = this.displaySlices[currentDisplayLine - 1];
				this.state.cursorLine = prevSlice.bufferLine;
				this.state.cursorCol = Math.max(prevSlice.startCol, prevSlice.endCol - 1); // endCol is exclusive
			}
		} else {
			if (this.state.cursorCol < currentSlice.endCol) {
				this.state.cursorCol += delta;
			} else if (currentDisplayLine < this.displaySlices.length - 1) {
				const nextSlice = this.displaySlices[currentDisplayLine + 1];
				this.state.cursorLine = nextSlice.bufferLine;
				this.state.cursorCol = nextSlice.startCol;
			}
		}
	}

	/** Word boundaries: whitespace and punctuation. Matches deleteWordBackwards behavior. */
	private moveWordLeft(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				this.state.cursorCol = (this.state.lines[this.state.cursorLine] || "").length;
			}
			this.clearTargetColumn();
			return;
		}

		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		const isWhitespace = (char: string): boolean => /\s/.test(char);
		const isPunctuation = (char: string): boolean => /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/.test(char);

		let newCol = this.state.cursorCol;

		while (newCol > 0 && isWhitespace(textBeforeCursor[newCol - 1] ?? "")) newCol--;

		if (newCol > 0 && isPunctuation(textBeforeCursor[newCol - 1] ?? "")) {
			newCol--;
		} else {
			while (newCol > 0) {
				const ch = textBeforeCursor[newCol - 1] ?? "";
				if (isWhitespace(ch) || isPunctuation(ch)) break;
				newCol--;
			}
		}

		this.state.cursorCol = newCol;
		this.clearTargetColumn();
	}

	private moveWordRight(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine++;
				this.state.cursorCol = 0;
			}
			this.clearTargetColumn();
			return;
		}

		const isWhitespace = (char: string): boolean => /\s/.test(char);
		const isPunctuation = (char: string): boolean => /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/.test(char);

		let newCol = this.state.cursorCol;

		if (isPunctuation(currentLine[newCol] ?? "")) {
			newCol++;
		} else {
			while (newCol < currentLine.length) {
				const ch = currentLine[newCol] ?? "";
				if (isWhitespace(ch) || isPunctuation(ch)) break;
				newCol++;
			}
		}

		while (newCol < currentLine.length && isWhitespace(currentLine[newCol] ?? "")) newCol++;

		this.state.cursorCol = newCol;
		this.clearTargetColumn();
	}

	// Helper method to check if cursor is at start of message (for slash command detection)
	private isAtStartOfMessage(): boolean {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		// At start if line is empty, only contains whitespace, or is just "/"
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	// Autocomplete methods
	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		if (!this.autocompleteProvider) return;

		// Check if we should trigger file completion on Tab
		if (explicitTab) {
			const provider = this.autocompleteProvider as CombinedAutocompleteProvider;
			const shouldTrigger =
				!provider.shouldTriggerFileCompletion ||
				provider.shouldTriggerFileCompletion(this.state.lines, this.state.cursorLine, this.state.cursorCol);
			if (!shouldTrigger) {
				return;
			}
		}

		const suggestions = this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);

		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			this.autocompleteList = new SelectList(suggestions.items, 5, this.theme.selectList);
			this.isAutocompleting = true;
		} else {
			this.cancelAutocomplete();
		}
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		// Check if we're in a slash command context
		if (beforeCursor.trimStart().startsWith("/")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete();
		}
	}

	private handleSlashCommandCompletion(): void {
		// For now, fall back to regular autocomplete (slash commands)
		// This can be extended later to handle command-specific argument completion
		this.tryTriggerAutocomplete(true);
	}

	/*
https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19536643416/job/559322883
17 this job fails with https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19
536643416/job/55932288317 havea  look at .gi
	 */
	private forceFileAutocomplete(): void {
		if (!this.autocompleteProvider) return;

		// Check if provider has the force method
		const provider = this.autocompleteProvider as any;
		if (!provider.getForceFileSuggestions) {
			this.tryTriggerAutocomplete(true);
			return;
		}

		const suggestions = provider.getForceFileSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);

		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			this.autocompleteList = new SelectList(suggestions.items, 5, this.theme.selectList);
			this.isAutocompleting = true;
		} else {
			this.cancelAutocomplete();
		}
	}

	private cancelAutocomplete(): void {
		this.isAutocompleting = false;
		this.autocompleteList = undefined as any;
		this.autocompletePrefix = "";
	}

	public isShowingAutocomplete(): boolean {
		return this.isAutocompleting;
	}

	private updateAutocomplete(): void {
		if (!this.isAutocompleting || !this.autocompleteProvider) return;

		const suggestions = this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);

		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			// Always create new SelectList to ensure update
			this.autocompleteList = new SelectList(suggestions.items, 5, this.theme.selectList);
		} else {
			// No matches - check if we're still in a valid context before cancelling
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);

			this.cancelAutocomplete();
		}
	}
}
