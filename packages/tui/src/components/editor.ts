import type { AutocompleteProvider, CombinedAutocompleteProvider } from "../autocomplete.js";
import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";
import { SelectList, type SelectListTheme } from "./select-list.js";

// Grapheme segmenter for proper Unicode iteration (handles emojis, surrogate pairs, etc.)
const segmenter = new Intl.Segmenter();

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
	scrollOffset: number;
}

interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

/** endCol is exclusive */
interface DisplaySlice {
	text: string;
	bufferLine: number;
	startCol: number;
	endCol: number;
}

interface ScrollbarGeometry {
	visibleHeight: number;
	maxScrollOffset: number;
	thumbStart: number;
	thumbSize: number;
}

interface ScrollbarDragState {
	startMouseRow: number;
	startScrollOffset: number;
	geometry: ScrollbarGeometry;
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
		scrollOffset: 0,
	};

	private theme: EditorTheme;

	public borderColor: (str: string) => string;
	public maxHeight: number | undefined = 10;
	public showTopBorder: boolean = true;
	public showBottomBorder: boolean = true;
	public cursorStyle: "reverse" | "underline" = "reverse";

	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteList?: SelectList;
	private isAutocompleting: boolean = false;
	private autocompletePrefix: string = "";

	private pastes: Map<number, string> = new Map();
	private pasteCounter: number = 0;

	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	private displaySlices: DisplaySlice[] = [];
	private lastRenderWidth: number = 0;
	private lastLayoutWidth: number = 0;
	private lastRenderHeight: number = 0;
	private targetDisplayCol: number | undefined = undefined;
	private scrollbarDragState: ScrollbarDragState | null = null;

	private isBatchingInput: boolean = false;
	private pendingEscapeBuffer: string = "";

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public onAutocompleteChange?: () => void;
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
		this.lastLayoutWidth = 0;
		this.lastRenderHeight = 0;
		this.state.scrollOffset = 0;
		this.targetDisplayCol = undefined;
		this.scrollbarDragState = null;
	}

	render(width: number): string[] {
		const horizontal = this.borderColor("─");

		const reserveScrollbar = this.maxHeight !== undefined;
		const layoutWidth = reserveScrollbar ? width - 1 : width;

		if (this.lastLayoutWidth !== layoutWidth || this.displaySlices.length === 0) {
			this.lastRenderWidth = width;
			this.lastLayoutWidth = layoutWidth;
			this.layoutText(layoutWidth);
		}

		const layoutLines = this.buildLayoutLines(layoutWidth);

		const result: string[] = [];

		const totalDisplayLines = layoutLines.length;
		const visibleHeight =
			this.maxHeight !== undefined ? Math.min(this.maxHeight, totalDisplayLines) : totalDisplayLines;
		this.lastRenderHeight = visibleHeight;

		const needsScrollbar = reserveScrollbar && totalDisplayLines > this.maxHeight!;
		const contentWidth = layoutWidth;

		const maxScrollOffset = Math.max(0, totalDisplayLines - visibleHeight);
		if (this.state.scrollOffset > maxScrollOffset) {
			this.state.scrollOffset = maxScrollOffset;
		}

		const visibleLayoutLines = layoutLines.slice(this.state.scrollOffset, this.state.scrollOffset + visibleHeight);

		let scrollbarThumbStart = 0;
		let scrollbarThumbSize = visibleHeight;
		if (needsScrollbar && totalDisplayLines > 0) {
			scrollbarThumbSize = Math.max(1, Math.floor((visibleHeight / totalDisplayLines) * visibleHeight));
			const scrollableRange = totalDisplayLines - visibleHeight;
			if (scrollableRange > 0) {
				scrollbarThumbStart = Math.floor(
					(this.state.scrollOffset / scrollableRange) * (visibleHeight - scrollbarThumbSize),
				);
			}
		}

		if (this.showTopBorder) {
			result.push(horizontal.repeat(width));
		}

		for (let i = 0; i < visibleLayoutLines.length; i++) {
			const layoutLine = visibleLayoutLines[i];
			let displayText = layoutLine.text;
			let visLen = visibleWidth(layoutLine.text);

			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				if (after.length > 0) {
					const cursor =
						this.cursorStyle === "underline" ? `\x1b[4m${after[0]}\x1b[24m` : `\x1b[7m${after[0]}\x1b[27m`;
					const restAfter = after.slice(1);
					displayText = before + cursor + restAfter;
				} else {
					if (visLen < contentWidth) {
						const cursor = "\x1b[4m \x1b[24m";
						displayText = before + cursor;
						visLen = visLen + 1;
					} else if (before.length > 0) {
						const lastChar = before[before.length - 1];
						const cursor = `\x1b[4m${lastChar}\x1b[24m`;
						displayText = before.slice(0, -1) + cursor;
					}
				}
			}

			const padding = " ".repeat(Math.max(0, contentWidth - visLen));

			let scrollbarChar = "";
			if (needsScrollbar) {
				const isThumb = i >= scrollbarThumbStart && i < scrollbarThumbStart + scrollbarThumbSize;
				scrollbarChar = isThumb ? "█" : "░";
			}

			result.push(displayText + padding + scrollbarChar);
		}

		if (this.showBottomBorder) {
			result.push(horizontal.repeat(width));
		}

		if (this.isAutocompleting && this.autocompleteList) {
			if (!this.autocompletePrefix.startsWith("/")) {
				const autocompleteResult = this.autocompleteList.render(width);
				result.push(...autocompleteResult);
			}
		}

		return result;
	}

	handleInput(data: string): void {
		// Bracketed paste mode
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		if (this.isInPaste) {
			this.pasteBuffer += data;

			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				this.handlePaste(pasteContent);

				this.isInPaste = false;

				const remaining = this.pasteBuffer.substring(endIndex + 6);
				this.pasteBuffer = "";

				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			} else {
				return;
			}
		}

		if (data.charCodeAt(0) === 3) return; // Ctrl+C

		if (this.isAutocompleting && this.autocompleteList) {
			if (data === "\x1b") {
				this.cancelAutocomplete();
				return;
			} else if (data === "\x1b[A" || data === "\x1b[B" || data === "\r" || data === "\t") {
				if (data === "\x1b[A" || data === "\x1b[B") {
					this.autocompleteList.handleInput(data);
					return;
				}

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

						// Refresh layout so the completion is visible immediately
						if (this.lastRenderWidth > 0) {
							const layoutWidth = this.maxHeight !== undefined ? this.lastRenderWidth - 1 : this.lastRenderWidth;
							this.layoutText(layoutWidth);
							this.ensureCursorVisible();
						}

						if (this.onChange) {
							this.onChange(this.getText());
						}
					}
					return;
				}

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

					// Refresh layout so the completion is visible immediately
					if (this.lastRenderWidth > 0) {
						const layoutWidth = this.maxHeight !== undefined ? this.lastRenderWidth - 1 : this.lastRenderWidth;
						this.layoutText(layoutWidth);
						this.ensureCursorVisible();
					}
				} else if (data === "\r") {
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

						// Refresh layout so the completion is visible immediately
						if (this.lastRenderWidth > 0) {
							const layoutWidth = this.maxHeight !== undefined ? this.lastRenderWidth - 1 : this.lastRenderWidth;
							this.layoutText(layoutWidth);
							this.ensureCursorVisible();
						}

						if (this.onChange) {
							this.onChange(this.getText());
						}
					}
					return;
				}
			}
		}

		if (data === "\t" && !this.isAutocompleting) {
			this.handleTabCompletion();
			return;
		}

		this.processInputBatch(data);
	}

	/**
	 * Process batched input (e.g. from text expanders that send backspaces + text in one chunk).
	 * Defers layout/onChange until batch completes. Matches escape sequences longest-first.
	 */
	private processInputBatch(data: string): void {
		if (this.pendingEscapeBuffer.length > 0) {
			data = this.pendingEscapeBuffer + data;
			this.pendingEscapeBuffer = "";
		}

		let textChanged = false;
		let cursorMoved = false;
		let viewportChanged = false;
		let i = 0;

		this.isBatchingInput = true;

		// Cursor operations need fresh layout after text mutations
		const ensureLayoutForCursor = (): void => {
			if (textChanged && this.lastRenderWidth > 0) {
				const layoutWidth = this.maxHeight !== undefined ? this.lastRenderWidth - 1 : this.lastRenderWidth;
				this.layoutText(layoutWidth);
			}
		};

		try {
			while (i < data.length) {
				const remaining = data.slice(i);
				const code = data.charCodeAt(i);

				// Match longest escape sequences first to avoid prefix conflicts

				if (remaining.startsWith("\x1b[1;3D")) {
					ensureLayoutForCursor();
					this.moveWordLeft();
					cursorMoved = true;
					i += 6;
					continue;
				}
				if (remaining.startsWith("\x1b[1;5D")) {
					ensureLayoutForCursor();
					this.moveWordLeft();
					cursorMoved = true;
					i += 6;
					continue;
				}
				if (remaining.startsWith("\x1b[1;3C")) {
					ensureLayoutForCursor();
					this.moveWordRight();
					cursorMoved = true;
					i += 6;
					continue;
				}
				if (remaining.startsWith("\x1b[1;5C")) {
					ensureLayoutForCursor();
					this.moveWordRight();
					cursorMoved = true;
					i += 6;
					continue;
				}

				if (remaining.startsWith("\x1b[13;2~")) {
					this.addNewLineCore();
					textChanged = true;
					i += 7;
					continue;
				}

				// Mouse scroll (variable length)
				if (remaining.startsWith("\x1b[<64;")) {
					const endMatch = remaining.match(/^\x1b\[<64;\d+;\d+[Mm]/);
					if (endMatch) {
						this.scroll(-3);
						viewportChanged = true;
						i += endMatch[0].length;
						continue;
					}
				}
				if (remaining.startsWith("\x1b[<65;")) {
					const endMatch = remaining.match(/^\x1b\[<65;\d+;\d+[Mm]/);
					if (endMatch) {
						this.scroll(3);
						viewportChanged = true;
						i += endMatch[0].length;
						continue;
					}
				}
				if (remaining.startsWith("\x1b[<32;") && this.maxHeight !== undefined) {
					const endMatch = remaining.match(/^\x1b\[<32;\d+;\d+[Mm]/);
					if (endMatch) {
						viewportChanged = this.handleScrollbarDrag(endMatch[0]) || viewportChanged;
						i += endMatch[0].length;
						continue;
					}
				}
				if (remaining.startsWith("\x1b[<0;") && this.maxHeight !== undefined) {
					const endMatch = remaining.match(/^\x1b\[<0;\d+;\d+[Mm]/);
					if (endMatch) {
						viewportChanged = this.handleScrollbarPointerDown(endMatch[0]) || viewportChanged;
						i += endMatch[0].length;
						continue;
					}
				}
				if (remaining.startsWith("\x1b[<") && this.maxHeight !== undefined) {
					const endMatch = remaining.match(/^\x1b\[<\d+;\d+;\d+m/);
					if (endMatch) {
						this.scrollbarDragState = null;
						i += endMatch[0].length;
						continue;
					}
				}

				if (remaining.startsWith("\x1b[1~")) {
					ensureLayoutForCursor();
					this.moveToLineStart();
					cursorMoved = true;
					i += 4;
					continue;
				}
				if (remaining.startsWith("\x1b[4~")) {
					ensureLayoutForCursor();
					this.moveToLineEnd();
					cursorMoved = true;
					i += 4;
					continue;
				}
				if (remaining.startsWith("\x1b[7~")) {
					ensureLayoutForCursor();
					this.moveToLineStart();
					cursorMoved = true;
					i += 4;
					continue;
				}
				if (remaining.startsWith("\x1b[8~")) {
					ensureLayoutForCursor();
					this.moveToLineEnd();
					cursorMoved = true;
					i += 4;
					continue;
				}
				if (remaining.startsWith("\x1b[3~")) {
					this.handleForwardDeleteCore();
					textChanged = true;
					i += 4;
					continue;
				}
				if (remaining.startsWith("\x1b[5~")) {
					ensureLayoutForCursor();
					this.scrollPage(-1);
					cursorMoved = true;
					i += 4;
					continue;
				}
				if (remaining.startsWith("\x1b[6~")) {
					ensureLayoutForCursor();
					this.scrollPage(1);
					cursorMoved = true;
					i += 4;
					continue;
				}

				if (remaining.startsWith("\x1b[A")) {
					ensureLayoutForCursor();
					this.moveCursor(-1, 0);
					cursorMoved = true;
					i += 3;
					continue;
				}
				if (remaining.startsWith("\x1b[B")) {
					ensureLayoutForCursor();
					this.moveCursor(1, 0);
					cursorMoved = true;
					i += 3;
					continue;
				}
				if (remaining.startsWith("\x1b[C")) {
					ensureLayoutForCursor();
					this.moveCursor(0, 1);
					cursorMoved = true;
					i += 3;
					continue;
				}
				if (remaining.startsWith("\x1b[D")) {
					ensureLayoutForCursor();
					this.moveCursor(0, -1);
					cursorMoved = true;
					i += 3;
					continue;
				}
				if (remaining.startsWith("\x1b[H")) {
					ensureLayoutForCursor();
					this.moveToLineStart();
					cursorMoved = true;
					i += 3;
					continue;
				}
				if (remaining.startsWith("\x1b[F")) {
					ensureLayoutForCursor();
					this.moveToLineEnd();
					cursorMoved = true;
					i += 3;
					continue;
				}
				if (remaining.startsWith("\x1bb")) {
					ensureLayoutForCursor();
					this.moveWordLeft();
					cursorMoved = true;
					i += 2;
					continue;
				}
				if (remaining.startsWith("\x1bf")) {
					ensureLayoutForCursor();
					this.moveWordRight();
					cursorMoved = true;
					i += 2;
					continue;
				}
				if (remaining.startsWith("\x1b\x7f")) {
					this.deleteWordBackwardsCore();
					textChanged = true;
					i += 2;
					continue;
				}
				if (remaining.startsWith("\x1b\r")) {
					this.addNewLineCore();
					textChanged = true;
					i += 2;
					continue;
				}
				if (remaining.startsWith("\\\r")) {
					this.addNewLineCore();
					textChanged = true;
					i += 2;
					continue;
				}

				// Unknown/incomplete escape sequences
				if (code === 0x1b) {
					if (remaining.length === 1) {
						this.pendingEscapeBuffer = "\x1b";
						break;
					}
					// CSI sequence: ESC[ params final-byte
					if (remaining[1] === "[") {
						let j = 2;
						let foundFinalByte = false;
						while (j < remaining.length) {
							const c = remaining.charCodeAt(j);
							if (c >= 0x40 && c <= 0x7e) {
								i += j + 1;
								foundFinalByte = true;
								break;
							}
							if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) {
								j++;
								continue;
							}
							i += 2;
							foundFinalByte = true;
							break;
						}
						if (!foundFinalByte) {
							this.pendingEscapeBuffer = remaining;
							break;
						}
						continue;
					}
					i += 2;
					continue;
				}

				if (code === 11) {
					// Ctrl+K
					this.deleteToEndOfLineCore();
					textChanged = true;
					i++;
					continue;
				}
				if (code === 21) {
					// Ctrl+U
					this.deleteToStartOfLineCore();
					textChanged = true;
					i++;
					continue;
				}
				if (code === 23) {
					// Ctrl+W
					this.deleteWordBackwardsCore();
					textChanged = true;
					i++;
					continue;
				}
				if (code === 1) {
					// Ctrl+A
					ensureLayoutForCursor();
					this.moveToLineStart();
					cursorMoved = true;
					i++;
					continue;
				}
				if (code === 5) {
					// Ctrl+E
					ensureLayoutForCursor();
					this.moveToLineEnd();
					cursorMoved = true;
					i++;
					continue;
				}
				if (code === 10) {
					this.addNewLineCore();
					textChanged = true;
					i++;
					continue;
				}

				// Enter: submit unless text expander is mid-replacement (has pending input after CR)
				if (code === 13) {
					const hasMoreInput = i < data.length - 1;
					const shouldSubmit = !this.disableSubmit && (!textChanged || !hasMoreInput);
					if (shouldSubmit) {
						this.isBatchingInput = false;
						this.handleSubmit();
						return;
					}
					i++;
					continue;
				}
				if (code === 127 || code === 8) {
					this.handleBackspaceCore();
					textChanged = true;
					i++;
					continue;
				}
				if (code >= 32) {
					this.insertCharacterCore(data[i]);
					textChanged = true;
					i++;
					continue;
				}
				i++;
			}
		} finally {
			this.isBatchingInput = false;
		}

		if (textChanged && this.lastRenderWidth > 0) {
			const layoutWidth = this.maxHeight !== undefined ? this.lastRenderWidth - 1 : this.lastRenderWidth;
			this.layoutText(layoutWidth);
			this.ensureCursorVisible();
		} else if (viewportChanged) {
			// Mouse-driven scrolling should not snap back to the cursor.
		} else if (cursorMoved) {
			this.ensureCursorVisible();
		}

		if (textChanged && this.onChange) {
			this.onChange(this.getText());
		}

		if (textChanged) {
			if (this.isAutocompleting) {
				this.updateAutocomplete();
			} else {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				if (textBeforeCursor.trimStart().startsWith("/") && this.isAtStartOfMessage()) {
					this.tryTriggerAutocomplete();
				} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
					this.tryTriggerAutocomplete();
				}
			}
		}
	}

	private handleSubmit(): void {
		const result = this.getExpandedText().trim();

		this.state = {
			lines: [""],
			cursorLine: 0,
			cursorCol: 0,
			scrollOffset: 0,
		};
		this.pastes.clear();
		this.pasteCounter = 0;
		this.invalidate();

		if (this.onChange) {
			this.onChange("");
		}

		if (this.onSubmit) {
			this.onSubmit(result);
		}
	}

	private layoutText(contentWidth: number): void {
		this.displaySlices = [];

		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			this.displaySlices.push({ text: "", bufferLine: 0, startCol: 0, endCol: 0 });
			return;
		}

		for (let bufferLine = 0; bufferLine < this.state.lines.length; bufferLine++) {
			const line = this.state.lines[bufferLine] || "";
			const lineVisibleWidth = visibleWidth(line);

			if (lineVisibleWidth <= contentWidth) {
				this.displaySlices.push({ text: line, bufferLine, startCol: 0, endCol: line.length });
			} else {
				const slices = this.wrapLineByVisibleWidth(line, contentWidth);
				for (const slice of slices) {
					this.displaySlices.push({
						text: slice.text,
						bufferLine,
						startCol: slice.startCol,
						endCol: slice.endCol,
					});
				}
			}
		}
	}

	private buildLayoutLines(_contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		if (this.displaySlices.length === 0) {
			layoutLines.push({ text: "", hasCursor: true, cursorPos: 0 });
			return layoutLines;
		}

		for (let i = 0; i < this.displaySlices.length; i++) {
			const slice = this.displaySlices[i];
			const isCurrentLine = slice.bufferLine === this.state.cursorLine;

			const isLastSliceForLine =
				i === this.displaySlices.length - 1 || this.displaySlices[i + 1].bufferLine !== slice.bufferLine;

			let hasCursorInSlice = false;
			if (isCurrentLine && this.state.cursorCol >= slice.startCol) {
				hasCursorInSlice = isLastSliceForLine
					? this.state.cursorCol <= slice.endCol
					: this.state.cursorCol < slice.endCol;
			}

			const cursorDisplayCol = hasCursorInSlice ? this.state.cursorCol - slice.startCol : undefined;

			layoutLines.push({ text: slice.text, hasCursor: hasCursorInSlice, cursorPos: cursorDisplayCol });
		}

		return layoutLines;
	}

	private wrapLineByVisibleWidth(
		line: string,
		maxWidth: number,
	): Array<{ text: string; startCol: number; endCol: number }> {
		const result: Array<{ text: string; startCol: number; endCol: number }> = [];
		let currentSliceStart = 0;
		let currentSliceText = "";
		let currentWidth = 0;

		// Iterate by grapheme clusters (not code units) to properly handle emojis and surrogate pairs
		for (const { segment, index } of segmenter.segment(line)) {
			const charWidth = visibleWidth(segment);

			if (currentWidth + charWidth > maxWidth && currentSliceText.length > 0) {
				// index is the start of current grapheme, which is the end of the previous slice
				result.push({ text: currentSliceText, startCol: currentSliceStart, endCol: index });
				currentSliceStart = index;
				currentSliceText = "";
				currentWidth = 0;
			}

			currentSliceText += segment;
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

	getExpandedText(): string {
		let result = this.getText();

		for (const [pasteId, pasteContent] of this.pastes) {
			const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			result = result.replace(markerRegex, pasteContent);
		}

		return result;
	}

	setText(text: string): void {
		const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = this.state.lines.length - 1;
		this.state.cursorCol = this.state.lines[this.state.cursorLine]?.length || 0;
		this.targetDisplayCol = undefined;

		this.invalidate();

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private clearTargetColumn(): void {
		this.targetDisplayCol = undefined;
	}

	/** Used by handlePaste (non-batched path) */
	private insertCharacter(char: string): void {
		this.insertCharacterCore(char);

		if (!this.isBatchingInput) {
			if (this.lastRenderWidth > 0) {
				const layoutWidth = this.maxHeight !== undefined ? this.lastRenderWidth - 1 : this.lastRenderWidth;
				this.layoutText(layoutWidth);
				this.ensureCursorVisible();
			}

			if (this.onChange) {
				this.onChange(this.getText());
			}

			if (!this.isAutocompleting) {
				if (char === "/" && this.isAtStartOfMessage()) {
					this.tryTriggerAutocomplete();
				} else if (char === "@") {
					const currentLine = this.state.lines[this.state.cursorLine] || "";
					const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
					const charBeforeAt = textBeforeCursor[textBeforeCursor.length - 2];
					if (textBeforeCursor.length === 1 || charBeforeAt === " " || charBeforeAt === "\t") {
						this.tryTriggerAutocomplete();
					}
				} else if (/[a-zA-Z0-9]/.test(char)) {
					const currentLine = this.state.lines[this.state.cursorLine] || "";
					const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
					if (textBeforeCursor.trimStart().startsWith("/")) {
						this.tryTriggerAutocomplete();
					} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
						this.tryTriggerAutocomplete();
					}
				}
			} else {
				this.updateAutocomplete();
			}
		}
	}

	private insertCharacterCore(char: string): void {
		const line = this.state.lines[this.state.cursorLine] || "";
		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.state.cursorCol += char.length;
		this.clearTargetColumn();
	}

	private handlePaste(pastedText: string): void {
		const cleanText = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const tabExpandedText = cleanText.replace(/\t/g, "    ");
		const filteredText = tabExpandedText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");

		const pastedLines = filteredText.split("\n");

		const totalChars = filteredText.length;
		if (pastedLines.length > 10 || totalChars > 1000) {
			this.pasteCounter++;
			const pasteId = this.pasteCounter;
			this.pastes.set(pasteId, filteredText);

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
			const text = pastedLines[0] || "";
			for (const char of text) {
				this.insertCharacter(char);
			}
			return;
		}

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		const newLines: string[] = [];

		for (let i = 0; i < this.state.cursorLine; i++) {
			newLines.push(this.state.lines[i] || "");
		}

		newLines.push(beforeCursor + (pastedLines[0] || ""));

		for (let i = 1; i < pastedLines.length - 1; i++) {
			newLines.push(pastedLines[i] || "");
		}

		newLines.push((pastedLines[pastedLines.length - 1] || "") + afterCursor);

		for (let i = this.state.cursorLine + 1; i < this.state.lines.length; i++) {
			newLines.push(this.state.lines[i] || "");
		}

		this.state.lines = newLines;

		this.state.cursorLine += pastedLines.length - 1;
		this.state.cursorCol = (pastedLines[pastedLines.length - 1] || "").length;

		this.clearTargetColumn();

		if (this.lastRenderWidth > 0) {
			const layoutWidth = this.maxHeight !== undefined ? this.lastRenderWidth - 1 : this.lastRenderWidth;
			this.layoutText(layoutWidth);
			this.ensureCursorVisible();
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private addNewLineCore(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		this.state.cursorLine++;
		this.state.cursorCol = 0;

		this.clearTargetColumn();
	}

	private handleBackspaceCore(): void {
		if (this.state.cursorCol > 0) {
			const line = this.state.lines[this.state.cursorLine] || "";
			const before = line.slice(0, this.state.cursorCol - 1);
			const after = line.slice(this.state.cursorCol);

			this.state.lines[this.state.cursorLine] = before + after;
			this.state.cursorCol--;
		} else if (this.state.cursorLine > 0) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			this.state.cursorLine--;
			this.state.cursorCol = previousLine.length;
		}

		this.clearTargetColumn();
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

	private deleteToStartOfLineCore(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol > 0) {
			this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
			this.state.cursorCol = 0;
		} else if (this.state.cursorLine > 0) {
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.state.cursorCol = previousLine.length;
		}

		this.clearTargetColumn();
	}

	private deleteToEndOfLineCore(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		this.clearTargetColumn();
	}

	private deleteWordBackwardsCore(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

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
			const isPunctuation = (char: string): boolean => /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/.test(char);

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
	}

	private handleForwardDeleteCore(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + 1);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		this.clearTargetColumn();
	}

	private moveCursor(deltaLine: number, deltaCol: number): void {
		if (this.displaySlices.length === 0 || this.lastRenderWidth === 0) {
			this.moveCursorLogical(deltaLine, deltaCol);
			return;
		}
		if (deltaLine !== 0) this.moveCursorVertical(deltaLine);
		if (deltaCol !== 0) this.moveCursorHorizontal(deltaCol);
		this.ensureCursorVisible();
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

	private isAtStartOfMessage(): boolean {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	isAtFirstLine(): boolean {
		return this.state.cursorLine === 0 && this.state.cursorCol === 0;
	}

	isAtLastLine(): boolean {
		const lastLineIndex = this.state.lines.length - 1;
		const lastLine = this.state.lines[lastLineIndex] || "";
		return this.state.cursorLine === lastLineIndex && this.state.cursorCol === lastLine.length;
	}

	isAtFirstVisualLine(): boolean {
		if (this.displaySlices.length === 0 || this.lastLayoutWidth === 0) {
			// Fall back to logical line check if layout not computed
			return this.state.cursorLine === 0;
		}
		return this.findCurrentDisplayLine() === 0;
	}

	isAtLastVisualLine(): boolean {
		if (this.displaySlices.length === 0 || this.lastLayoutWidth === 0) {
			// Fall back to logical line check if layout not computed
			const lastLineIndex = this.state.lines.length - 1;
			return this.state.cursorLine === lastLineIndex;
		}
		return this.findCurrentDisplayLine() === this.displaySlices.length - 1;
	}

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
			this.onAutocompleteChange?.();
		} else {
			this.cancelAutocomplete();
		}
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		if (beforeCursor.trimStart().startsWith("/")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete();
		}
	}

	private handleSlashCommandCompletion(): void {
		this.tryTriggerAutocomplete(true);
	}

	private forceFileAutocomplete(): void {
		if (!this.autocompleteProvider) return;

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
			this.onAutocompleteChange?.();
		} else {
			this.cancelAutocomplete();
		}
	}

	private cancelAutocomplete(): void {
		this.isAutocompleting = false;
		this.autocompleteList = undefined as any;
		this.autocompletePrefix = "";
		this.onAutocompleteChange?.();
	}

	public isShowingAutocomplete(): boolean {
		return this.isAutocompleting;
	}

	public isShowingSlashCommandAutocomplete(): boolean {
		return this.isAutocompleting && !!this.autocompleteList && this.autocompletePrefix.startsWith("/");
	}

	public hideAutocomplete(): void {
		this.cancelAutocomplete();
	}

	public renderDetachedSlashCommandAutocomplete(width: number): string[] {
		if (!this.isShowingSlashCommandAutocomplete() || !this.autocompleteList) {
			return [];
		}
		return this.autocompleteList.render(width);
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
			this.autocompleteList = new SelectList(suggestions.items, 5, this.theme.selectList);
			this.onAutocompleteChange?.();
		} else {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);

			this.cancelAutocomplete();
		}
	}

	private ensureCursorVisible(): void {
		if (this.maxHeight === undefined || this.displaySlices.length === 0) return;

		const cursorDisplayLine = this.findCurrentDisplayLine();
		const visibleHeight = Math.min(this.maxHeight, this.displaySlices.length);

		if (cursorDisplayLine < this.state.scrollOffset) {
			this.state.scrollOffset = cursorDisplayLine;
		} else if (cursorDisplayLine >= this.state.scrollOffset + visibleHeight) {
			this.state.scrollOffset = cursorDisplayLine - visibleHeight + 1;
		}
	}

	public scroll(lines: number): void {
		if (this.maxHeight === undefined || this.displaySlices.length === 0) return;

		const totalDisplayLines = this.displaySlices.length;
		const visibleHeight = Math.min(this.maxHeight, totalDisplayLines);
		const maxScrollOffset = Math.max(0, totalDisplayLines - visibleHeight);

		this.state.scrollOffset = Math.max(0, Math.min(maxScrollOffset, this.state.scrollOffset + lines));
	}

	private scrollPage(direction: number): void {
		if (this.lastRenderHeight === 0) return;

		const scrollAmount = Math.max(1, this.lastRenderHeight - 2);
		this.scroll(direction * scrollAmount);

		const cursorDisplayLine = this.findCurrentDisplayLine();
		const visibleHeight = this.lastRenderHeight;

		if (cursorDisplayLine < this.state.scrollOffset) {
			const newSlice = this.displaySlices[this.state.scrollOffset];
			if (newSlice) {
				this.state.cursorLine = newSlice.bufferLine;
				this.state.cursorCol = newSlice.startCol;
			}
		} else if (cursorDisplayLine >= this.state.scrollOffset + visibleHeight) {
			const newDisplayLine = this.state.scrollOffset + visibleHeight - 1;
			const newSlice = this.displaySlices[newDisplayLine];
			if (newSlice) {
				this.state.cursorLine = newSlice.bufferLine;
				this.state.cursorCol = newSlice.startCol;
			}
		}

		this.clearTargetColumn();
	}

	private getScrollbarGeometry(): ScrollbarGeometry | null {
		if (this.maxHeight === undefined || this.lastRenderHeight === 0) return null;

		const visibleHeight = this.lastRenderHeight;
		const totalDisplayLines = this.displaySlices.length;
		const maxScrollOffset = Math.max(0, totalDisplayLines - visibleHeight);
		const needsScrollbar = totalDisplayLines > this.maxHeight;

		if (!needsScrollbar) {
			return {
				visibleHeight,
				maxScrollOffset,
				thumbStart: 0,
				thumbSize: visibleHeight,
			};
		}

		const thumbSize = Math.max(1, Math.floor((visibleHeight / totalDisplayLines) * visibleHeight));
		let thumbStart = 0;
		if (maxScrollOffset > 0) {
			thumbStart = Math.floor((this.state.scrollOffset / maxScrollOffset) * (visibleHeight - thumbSize));
		}

		return { visibleHeight, maxScrollOffset, thumbStart, thumbSize };
	}

	private isScrollbarColumn(x: number): boolean {
		return x === this.lastRenderWidth;
	}

	private parseMousePosition(data: string): { x: number; y: number } | null {
		const match = data.match(/\x1b\[<\d+;(\d+);(\d+)[Mm]/);
		if (!match) return null;
		return {
			x: parseInt(match[1], 10),
			y: parseInt(match[2], 10),
		};
	}

	private handleScrollbarPointerDown(data: string): boolean {
		return this.handleScrollbarClick(data);
	}

	/** LIMITATION: Assumes Editor receives local mouse coords relative to its own render box. */
	private handleScrollbarClick(data: string): boolean {
		const position = this.parseMousePosition(data);
		if (!position) return false;
		const { x, y } = position;

		if (!this.isScrollbarColumn(x)) return false;

		const clickedRow = y - 2;
		if (clickedRow < 0 || clickedRow >= this.lastRenderHeight) return false;

		const geometry = this.getScrollbarGeometry();
		if (!geometry) return false;

		const isOnThumb = clickedRow >= geometry.thumbStart && clickedRow < geometry.thumbStart + geometry.thumbSize;
		if (isOnThumb) {
			this.scrollbarDragState = {
				startMouseRow: clickedRow,
				startScrollOffset: this.state.scrollOffset,
				geometry,
			};
			return true;
		}

		const scrollRatio = clickedRow / Math.max(1, geometry.visibleHeight - 1);
		this.state.scrollOffset = Math.round(scrollRatio * geometry.maxScrollOffset);
		this.scrollbarDragState = null;
		return true;
	}

	private handleScrollbarDrag(data: string): boolean {
		const position = this.parseMousePosition(data);
		if (!position) return false;
		if (!this.scrollbarDragState) return false;

		const clickedRow = position.y - 2;
		const { geometry, startMouseRow, startScrollOffset } = this.scrollbarDragState;
		const trackTravel = Math.max(1, geometry.visibleHeight - geometry.thumbSize);
		const maxScrollOffset = geometry.maxScrollOffset;
		if (maxScrollOffset === 0) return false;

		const rowDelta = clickedRow - startMouseRow;
		const scrollDelta = Math.round((rowDelta / trackTravel) * maxScrollOffset);
		const nextOffset = Math.max(0, Math.min(maxScrollOffset, startScrollOffset + scrollDelta));
		if (nextOffset === this.state.scrollOffset) return false;

		this.state.scrollOffset = nextOffset;
		return true;
	}

	public getScrollOffset(): number {
		return this.state.scrollOffset;
	}

	public setScrollOffset(offset: number): void {
		this.state.scrollOffset = Math.max(0, offset);
	}
}
