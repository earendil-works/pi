import type { AutocompleteProvider, AutocompleteSuggestions, CombinedAutocompleteProvider } from "../autocomplete.js";
import { getKeybindings } from "../keybindings.js";
import { decodeKittyPrintable, matchesKey } from "../keys.js";
import { KillRing } from "../kill-ring.js";
import { type Component, CURSOR_MARKER, type Focusable, type TUI } from "../tui.js";
import { UndoStack } from "../undo-stack.js";
import { getSegmenter, isPunctuationChar, isWhitespaceChar, truncateToWidth, visibleWidth } from "../utils.js";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.js";

const baseSegmenter = getSegmenter();

/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Non-global version for single-segment testing. */
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

/** Check if a segment is a paste marker (i.e. was merged by segmentWithMarkers). */
function isPasteMarker(segment: string): boolean {
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

/**
 * A segmenter that wraps Intl.Segmenter and merges graphemes that fall
 * within paste markers into single atomic segments.  This makes cursor
 * movement, deletion, word-wrap, etc. treat paste markers as single units.
 *
 * Only markers whose numeric ID exists in `validIds` are merged.
 */
function segmentWithMarkers(text: string, validIds: Set<number>): Iterable<Intl.SegmentData> {
	// Fast path: no paste markers in the text or no valid IDs.
	if (validIds.size === 0 || !text.includes("[paste #")) {
		return baseSegmenter.segment(text);
	}

	// Find all marker spans with valid IDs.
	const markers: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
		const id = Number.parseInt(m[1]!, 10);
		if (!validIds.has(id)) continue;
		markers.push({ start: m.index, end: m.index + m[0].length });
	}
	if (markers.length === 0) {
		return baseSegmenter.segment(text);
	}

	// Build merged segment list.
	const baseSegments = baseSegmenter.segment(text);
	const result: Intl.SegmentData[] = [];
	let markerIdx = 0;

	for (const seg of baseSegments) {
		// Skip past markers that are entirely before this segment.
		while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
			markerIdx++;
		}

		const marker = markerIdx < markers.length ? markers[markerIdx]! : null;

		if (marker && seg.index >= marker.start && seg.index < marker.end) {
			// This segment falls inside a marker.
			// If this is the first segment of the marker, emit a merged segment.
			if (seg.index === marker.start) {
				const markerText = text.slice(marker.start, marker.end);
				result.push({
					segment: markerText,
					index: marker.start,
					input: text,
				});
			}
			// Otherwise skip (already merged into the first segment).
		} else {
			result.push(seg);
		}
	}

	return result;
}

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional pre-segmented graphemes (e.g. with paste-marker awareness).
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = preSegmented ?? [...baseSegmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

		// Overflow check before advancing.
		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				// Backtrack to last wrap opportunity (the remaining content
				// plus the current grapheme still fits within maxWidth).
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				// No viable wrap opportunity: force-break at current position.
				// This also handles the case where backtracking to a word
				// boundary wouldn't help because the remaining content plus
				// the current grapheme (e.g. a wide character) still exceeds
				// maxWidth.
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			// Single atomic segment wider than maxWidth (e.g. paste marker
			// in a narrow terminal). Re-wrap it at grapheme granularity.

			// The segment remains logically atomic for cursor
			// movement / editing — the split is purely visual for word-wrap layout.
			const subChunks = wordWrapLine(grapheme, maxWidth);
			for (let j = 0; j < subChunks.length - 1; j++) {
				const sc = subChunks[j]!;
				chunks.push({ text: sc.text, startIndex: charIndex + sc.startIndex, endIndex: charIndex + sc.endIndex });
			}
			const last = subChunks[subChunks.length - 1]!;
			chunkStart = charIndex + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOppIndex = -1;
			continue;
		}

		// Advance.
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace.
		// Multiple spaces join (no break between them); the break point is
		// after the last space before the next word.
		const next = segments[i + 1];
		if (isWs && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		}
	}

	// Push final chunk.
	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });

	return chunks;
}

// Kitty CSI-u sequences for printable keys, including optional shifted/base codepoints.
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

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}

export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
}

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;

export class Editor implements Component, Focusable {
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	protected tui: TUI;
	private theme: EditorTheme;
	private paddingX: number = 0;

	// Store last render width for cursor navigation
	private lastWidth: number = 80;

	// Vertical scrolling support
	private scrollOffset: number = 0;

	// Border color (can be changed dynamically)
	public borderColor: (str: string) => string;

	// Autocomplete support
	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteList?: SelectList;
	private autocompleteState: "regular" | "force" | null = null;
	private autocompletePrefix: string = "";
	private autocompleteMaxVisible: number = 5;
	private autocompleteAbort?: AbortController;
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	private autocompleteRequestTask: Promise<void> = Promise.resolve();
	private autocompleteStartToken: number = 0;
	private autocompleteRequestId: number = 0;

	// Paste tracking for large pastes
	private pastes: Map<number, string> = new Map();
	private pasteCounter: number = 0;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// Prompt history for up/down navigation
	private history: string[] = [];
	private historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.

	// Kill ring for Emacs-style kill/yank operations
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Character jump mode
	private jumpMode: "forward" | "backward" | null = null;

	// Preferred visual column for vertical cursor movement (sticky column)
	private preferredVisualCol: number | null = null;

	// Undo support
	private undoStack = new UndoStack<EditorState>();

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.borderColor = theme.borderColor;
		const paddingX = options.paddingX ?? 0;
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
	}

	/** Set of currently valid paste IDs, for marker-aware segmentation. */
	private validPasteIds(): Set<number> {
		return new Set(this.pastes.keys());
	}

	/** Segment text with paste-marker awareness, only merging markers with valid IDs. */
	private segment(text: string): Iterable<Intl.SegmentData> {
		return segmentWithMarkers(text, this.validPasteIds());
	}

	getPaddingX(): number {
		return this.paddingX;
	}

	setPaddingX(padding: number): void {
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		if (this.paddingX !== newPadding) {
			this.paddingX = newPadding;
			this.tui.requestRender();
		}
	}

	getAutocompleteMaxVisible(): number {
		return this.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.autocompleteMaxVisible !== newMaxVisible) {
			this.autocompleteMaxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.autocompleteProvider = provider;
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Don't add consecutive duplicates
		if (this.history.length > 0 && this.history[0] === trimmed) return;
		this.history.unshift(trimmed);
		// Limit history size
		if (this.history.length > 100) {
			this.history.pop();
		}
	}

	private isEditorEmpty(): boolean {
		return this.state.lines.length === 1 && this.state.lines[0] === "";
	}

	private isOnFirstVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	private isOnLastVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	private navigateHistory(direction: 1 | -1): void {
		this.lastAction = null;
		if (this.history.length === 0) return;

		const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.history.length) return;

		// Capture state when first entering history browsing mode
		if (this.historyIndex === -1 && newIndex >= 0) {
			this.pushUndoSnapshot();
		}

		this.historyIndex = newIndex;

		if (this.historyIndex === -1) {
			// Returned to "current" state - clear editor
			this.setTextInternal("");
		} else {
			this.setTextInternal(this.history[this.historyIndex] || "");
		}
	}

	/** Internal setText that doesn't reset history state - used by navigateHistory */
	private setTextInternal(text: string): void {
		const lines = text.split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = this.state.lines.length - 1;
		this.setCursorCol(this.state.lines[this.state.cursorLine]?.length || 0);
		// Reset scroll - render() will adjust to show cursor
		this.scrollOffset = 0;

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.paddingX, maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Layout width: with padding the cursor can overflow into it,
		// without padding we reserve 1 column for the cursor.
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		// Store for cursor navigation (must match wrapping width)
		this.lastWidth = layoutWidth;

		const horizontal = this.borderColor("─");

		// Layout the text
		const layoutLines = this.layoutText(layoutWidth);

		// Calculate max visible lines: 30% of terminal height, minimum 5 lines
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		// Find the cursor line index in layoutLines
		let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		if (cursorLineIndex === -1) cursorLineIndex = 0;

		// Adjust scroll offset to keep cursor visible
		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		// Clamp scroll offset to valid range
		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

		// Get visible lines slice
		const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;

		// Render top border (with scroll indicator if scrolled down)
		if (this.scrollOffset > 0) {
			const indicator = `─── ↑ ${this.scrollOffset} more `;
			const remaining = width - visibleWidth(indicator);
			if (remaining >= 0) {
				result.push(this.borderColor(indicator + "─".repeat(remaining)));
			} else {
				result.push(this.borderColor(truncateToWidth(indicator, width)));
			}
		} else {
			result.push(horizontal.repeat(width));
		}

		// Render each visible layout line
		// Emit hardware cursor marker only when focused and not showing autocomplete
		const emitCursorMarker = this.focused && !this.autocompleteState;

		for (const layoutLine of visibleLines) {
			let displayText = layoutLine.text;
			let lineVisibleWidth = visibleWidth(layoutLine.text);
			let cursorInPadding = false;

			// Add cursor if this line has it
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
				const marker = emitCursorMarker ? CURSOR_MARKER : "";

				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					const afterGraphemes = [...this.segment(after)];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;
					displayText = before + marker + cursor + restAfter;
					// lineVisibleWidth stays the same - we're replacing, not adding
				} else {
					// Cursor is at the end - add highlighted space
					const cursor = "\x1b[7m \x1b[0m";
					displayText = before + marker + cursor;
					lineVisibleWidth = lineVisibleWidth + 1;
					// If cursor overflows content width into the padding, flag it
					if (lineVisibleWidth > contentWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			// Calculate padding based on actual visible width
			const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			// Render the line (no side borders, just horizontal lines above and below)
			result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);
		}

		// Render bottom border (with scroll indicator if more content below)
		const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
		if (linesBelow > 0) {
			const indicator = `─── ↓ ${linesBelow} more `;
			const remaining = width - visibleWidth(indicator);
			result.push(this.borderColor(indicator + "─".repeat(Math.max(0, remaining))));
		} else {
			result.push(horizontal.repeat(width));
		}

		// Add autocomplete list if active
		if (this.autocompleteState && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(contentWidth);
			for (const line of autocompleteResult) {
				const lineWidth = visibleWidth(line);
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		return result;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Handle character jump mode (awaiting next character to jump to)
		if (this.jumpMode !== null) {
			// Cancel if the hotkey is pressed again
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.jumpMode = null;
				return;
			}

			if (data.charCodeAt(0) >= 32) {
				// Printable character - perform the jump
				const direction = this.jumpMode;
				this.jumpMode = null;
				this.jumpToChar(data, direction);
				return;
			}

			// Control character - cancel and fall through to normal handling
			this.jumpMode = null;
		}

		// Handle bracketed paste mode
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
				if (pasteContent.length > 0) {
					this.handlePaste(pasteContent);
				}
				this.isInPaste = false;
				const remaining = this.pasteBuffer.substring(endIndex + 6);
				this.pasteBuffer = "";
				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			}
			return;
		}

		// Ctrl+C - let parent handle (exit/clear)
		if (kb.matches(data, "tui.input.copy")) {
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		// Handle autocomplete mode
		if (this.autocompleteState && this.autocompleteList) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.cancelAutocomplete();
				return;
			}

			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
				this.autocompleteList.handleInput(data);
				return;
			}

			if (kb.matches(data, "tui.input.tab")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);
					this.cancelAutocomplete();
					if (this.onChange) this.onChange(this.getText());
				}
				return;
			}

			if (kb.matches(data, "tui.select.confirm")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);

					if (this.autocompletePrefix.startsWith("/")) {
						this.cancelAutocomplete();
						// Fall through to submit
					} else {
						this.cancelAutocomplete();
						if (this.onChange) this.onChange(this.getText());
						return;
					}
				}
			}
		}

		// Tab - trigger completion
		if (kb.matches(data, "tui.input.tab") && !this.autocompleteState) {
			this.handleTabCompletion();
			return;
		}

		// Deletion actions
		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToEndOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToStartOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.deleteWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.deleteWordForward();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.handleBackspace();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.handleForwardDelete();
			return;
		}

		// Kill ring actions
		if (kb.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.yankPop();
			return;
		}

		// Cursor movement actions
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.moveToLineStart();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.moveToLineEnd();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		// New line
		if (
			kb.matches(data, "tui.input.newLine") ||
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1)
		) {
			if (this.shouldSubmitOnBackslashEnter(data, kb)) {
				this.handleBackspace();
				this.submitValue();
				return;
			}
			this.addNewLine();
			return;
		}

		// Submit (Enter)
		if (kb.matches(data, "tui.input.submit")) {
			if (this.disableSubmit) return;

			// Workaround for terminals without Shift+Enter support:
			// If char before cursor is \, delete it and insert newline instead of submitting.
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			if (this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\") {
				this.handleBackspace();
				this.addNewLine();
				return;
			}

			this.submitValue();
			return;
		}

		// Arrow key navigation (with history support)
		if (kb.matches(data, "tui.editor.cursorUp")) {
			if (this.isEditorEmpty()) {
				this.navigateHistory(-1);
			} else if (this.historyIndex > -1 && this.isOnFirstVisualLine()) {
				this.navigateHistory(-1);
			} else if (this.isOnFirstVisualLine()) {
				// Already at top - jump to start of line
				this.moveToLineStart();
			} else {
				this.moveCursor(-1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorDown")) {
			if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
				this.navigateHistory(1);
			} else if (this.isOnLastVisualLine()) {
				// Already at bottom - jump to end of line
				this.moveToLineEnd();
			} else {
				this.moveCursor(1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.moveCursor(0, 1);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.moveCursor(0, -1);
			return;
		}

		// Page up/down - scroll by page and move cursor
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.pageScroll(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.pageScroll(1);
			return;
		}

		// Character jump mode triggers
		if (kb.matches(data, "tui.editor.jumpForward")) {
			this.jumpMode = "forward";
			return;
		}
		if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.jumpMode = "backward";
			return;
		}

		// Shift+Space - insert regular space
		if (matchesKey(data, "shift+space")) {
			this.insertCharacter(" ");
			return;
		}

		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) {
			this.insertCharacter(kittyPrintable);
			return;
		}

		// Regular characters
		if (data.charCodeAt(0) >= 32) {
			this.insertCharacter(data);
		}
	}

	private layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			// Empty editor
			layoutLines.push({
				text: "",
				hasCursor: true,
				cursorPos: 0,
			});
			return layoutLines;
		}

		// Process each logical line
		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const isCurrentLine = i === this.state.cursorLine;
			const lineVisibleWidth = visibleWidth(line);

			if (lineVisibleWidth <= contentWidth) {
				// Line fits in one layout line
				if (isCurrentLine) {
					layoutLines.push({
						text: line,
						hasCursor: true,
						cursorPos: this.state.cursorCol,
					});
				} else {
					layoutLines.push({
						text: line,
						hasCursor: false,
					});
				}
			} else {
				// Line needs wrapping - use word-aware wrapping
				const chunks = wordWrapLine(line, contentWidth, [...this.segment(line)]);

				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					const chunk = chunks[chunkIndex];
					if (!chunk) continue;

					const cursorPos = this.state.cursorCol;
					const isLastChunk = chunkIndex === chunks.length - 1;

					// Determine if cursor is in this chunk
					// For word-wrapped chunks, we need to handle the case where
					// cursor might be in trimmed whitespace at end of chunk
					let hasCursorInChunk = false;
					let adjustedCursorPos = 0;

					if (isCurrentLine) {
						if (isLastChunk) {
							// Last chunk: cursor belongs here if >= startIndex
							hasCursorInChunk = cursorPos >= chunk.startIndex;
							adjustedCursorPos = cursorPos - chunk.startIndex;
						} else {
							// Non-last chunk: cursor belongs here if in range [startIndex, endIndex)
							// But we need to handle the visual position in the trimmed text
							hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
							if (hasCursorInChunk) {
								adjustedCursorPos = cursorPos - chunk.startIndex;
								// Clamp to text length (in case cursor was in trimmed whitespace)
								if (adjustedCursorPos > chunk.text.length) {
									adjustedCursorPos = chunk.text.length;
								}
							}
						}
					}

					if (hasCursorInChunk) {
						layoutLines.push({
							text: chunk.text,
							hasCursor: true,
							cursorPos: adjustedCursorPos,
						});
					} else {
						layoutLines.push({
							text: chunk.text,
							hasCursor: false,
						});
					}
				}
			}
		}

		return layoutLines;
	}

	getText(): string {
		return this.state.lines.join("\n");
	}

	private expandPasteMarkers(text: string): string {
		let result = text;
		for (const [pasteId, pasteContent] of this.pastes) {
			const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			result = result.replace(markerRegex, () => pasteContent);
		}
		return result;
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	getExpandedText(): string {
		return this.expandPasteMarkers(this.state.lines.join("\n"));
	}

	getLines(): string[] {
		return [...this.state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}

	setText(text: string): void {
		this.cancelAutocomplete();
		this.lastAction = null;
		this.historyIndex = -1; // Exit history browsing mode
		const normalized = this.normalizeText(text);
		// Push undo snapshot if content differs (makes programmatic changes undoable)
		if (this.getText() !== normalized) {
			this.pushUndoSnapshot();
		}
		this.setTextInternal(normalized);
	}

	/**
	 * Insert text at the current cursor position.
	 * Used for programmatic insertion (e.g., clipboard image markers).
	 * This is atomic for undo - single undo restores entire pre-insert state.
	 */
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.cancelAutocomplete();
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.historyIndex = -1;
		this.insertTextAtCursorInternal(text);
	}

	/**
	 * Normalize text for editor storage:
	 * - Normalize line endings (\r\n and \r -> \n)
	 * - Expand tabs to 4 spaces
	 */
	private normalizeText(text: string): string {
		return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	}

	/**
	 * Internal text insertion at cursor. Handles single and multi-line text.
	 * Does not push undo snapshots or trigger autocomplete - caller is responsible.
	 * Normalizes line endings and calls onChange once at the end.
	 */
	private insertTextAtCursorInternal(text: string): void {
		if (!text) return;

		// Normalize line endings and tabs
		const normalized = this.normalizeText(text);
		const insertedLines = normalized.split("\n");

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		if (insertedLines.length === 1) {
			// Single line - insert at cursor position
			this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
			this.setCursorCol(this.state.cursorCol + normalized.length);
		} else {
			// Multi-line insertion
			this.state.lines = [
				// All lines before current line
				...this.state.lines.slice(0, this.state.cursorLine),

				// The first inserted line merged with text before cursor
				beforeCursor + insertedLines[0],

				// All middle inserted lines
				...insertedLines.slice(1, -1),

				// The last inserted line with text after cursor
				insertedLines[insertedLines.length - 1] + afterCursor,

				// All lines after current line
				...this.state.lines.slice(this.state.cursorLine + 1),
			];

			this.state.cursorLine += insertedLines.length - 1;
			this.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	// All the editor methods from before...
	private insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		this.historyIndex = -1; // Exit history browsing mode

		// Undo coalescing (fish-style):
		// - Consecutive word chars coalesce into one undo unit
		// - Space captures state before itself (so undo removes space+following word together)
		// - Each space is separately undoable
		// Skip coalescing when called from atomic operations (e.g., handlePaste)
		if (!skipUndoCoalescing) {
			if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
				this.pushUndoSnapshot();
			}
			this.lastAction = "type-word";
		}

		const line = this.state.lines[this.state.cursorLine] || "";

		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.setCursorCol(this.state.cursorCol + char.length);

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Check if we should trigger or update autocomplete
		if (!this.autocompleteState) {
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
			else if (/[a-zA-Z0-9.\-_]/.test(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// Check if we're in a slash command (with or without space for arguments)
				if (this.isInSlashCommandContext(textBeforeCursor)) {
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
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		// Clean the pasted text: normalize line endings, expand tabs
		const cleanText = this.normalizeText(pastedText);

		// Filter out non-printable characters except newlines
		let filteredText = cleanText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");

		// If pasting a file path (starts with /, ~, or .) and the character before
		// the cursor is a word character, prepend a space for better readability
		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		// Split into lines to check for large paste
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
			this.insertTextAtCursorInternal(marker);
			return;
		}

		if (pastedLines.length === 1) {
			// Single line - insert atomically (do not trigger autocomplete during paste)
			this.insertTextAtCursorInternal(filteredText);
			return;
		}

		// Multi-line paste - use direct state manipulation
		this.insertTextAtCursorInternal(filteredText);
	}

	private addNewLine(): void {
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		// Split current line
		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		// Move cursor to start of new line
		this.state.cursorLine++;
		this.setCursorCol(0);

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private shouldSubmitOnBackslashEnter(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		return this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\";
	}

	private submitValue(): void {
		this.cancelAutocomplete();
		const result = this.expandPasteMarkers(this.state.lines.join("\n")).trim();

		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.pastes.clear();
		this.pasteCounter = 0;
		this.historyIndex = -1;
		this.scrollOffset = 0;
		this.undoStack.clear();
		this.lastAction = null;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	private handleBackspace(): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// Delete grapheme before cursor (handles emojis, combining characters, etc.)
			const line = this.state.lines[this.state.cursorLine] || "";
			const beforeCursor = line.slice(0, this.state.cursorCol);

			// Find the last grapheme in the text before cursor
			const graphemes = [...this.segment(beforeCursor)];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

			const before = line.slice(0, this.state.cursorCol - graphemeLength);
			const after = line.slice(this.state.cursorCol);

			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - graphemeLength);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// Merge with previous line
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after backspace
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			// If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// @ file reference context
			else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	private setCursorCol(col: number): void {
		this.state.cursorCol = col;
		this.preferredVisualCol = null;
	}

	/**
	 * Move cursor to a target visual line, applying sticky column logic.
	 * Shared by moveCursor() and pageScroll().
	 */
	private moveToVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];

		if (currentVL && targetVL) {
			const currentVisualCol = this.state.cursorCol - currentVL.startCol;

			// For non-last segments, clamp to length-1 to stay within the segment
			const isLastSourceSegment =
				currentVisualLine === visualLines.length - 1 ||
				visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
			const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);

			const isLastTargetSegment =
				targetVisualLine === visualLines.length - 1 ||
				visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
			const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);

			const moveToVisualCol = this.computeVerticalMoveColumn(
				currentVisualCol,
				sourceMaxVisualCol,
				targetMaxVisualCol,
			);

			// Set cursor position
			this.state.cursorLine = targetVL.logicalLine;
			const targetCol = targetVL.startCol + moveToVisualCol;
			const logicalLine = this.state.lines[targetVL.logicalLine] || "";
			this.state.cursorCol = Math.min(targetCol, logicalLine.length);

			// Snap cursor to atomic segment boundary (e.g. paste markers)
			// so the cursor never lands in the middle of a multi-grapheme unit.
			// Single-grapheme segments don't need snapping.
			const segments = [...this.segment(logicalLine)];
			for (const seg of segments) {
				if (seg.index > this.state.cursorCol) break;
				if (seg.segment.length <= 1) continue;
				if (this.state.cursorCol < seg.index + seg.segment.length) {
					// jump to the start of the segment when moving up, to the end when moving down.
					this.state.cursorCol = currentVisualLine > targetVisualLine ? seg.index : seg.index + seg.segment.length;
					break;
				}
			}
		}
	}

	/**
	 * Compute the target visual column for vertical cursor movement.
	 * Implements the sticky column decision table:
	 *
	 * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
	 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
	 * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
	 * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
	 * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
	 * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
	 * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
	 * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
	 * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
	 *
	 * Where:
	 * - P = preferred col is set
	 * - S = cursor in middle of source line (not clamped to end)
	 * - T = target line shorter than current visual col
	 * - U = target line shorter than preferred col
	 */
	private computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.preferredVisualCol !== null; // P
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
		const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				// Cases 2 and 7
				this.preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}

			// Cases 1 and 6
			this.preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol!; // U
		if (targetTooShort || targetCantFitPreferred) {
			// Cases 4 and 5
			return targetMaxVisualCol;
		}

		// Case 3
		const result = this.preferredVisualCol!;
		this.preferredVisualCol = null;
		return result;
	}

	private moveToLineStart(): void {
		this.lastAction = null;
		this.setCursorCol(0);
	}

	private moveToLineEnd(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.setCursorCol(currentLine.length);
	}

	private deleteToStartOfLine(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (backward deletion = prepend)
			const deletedText = currentLine.slice(0, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// Delete from start of line up to cursor
			this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
			this.setCursorCol(0);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// At start of line - merge with previous line, treating newline as deleted text
			this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteToEndOfLine(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (forward deletion = append)
			const deletedText = currentLine.slice(this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// Delete from cursor to end of line
			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line, treating newline as deleted text
			this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordBackwards(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, behave like backspace at column 0 (merge with previous line)
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (backward deletion = prepend)
				this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
				this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
				this.state.lines.splice(this.state.cursorLine, 1);
				this.state.cursorLine--;
				this.setCursorCol(previousLine.length);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordBackwards resets it)
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordBackwards();
			const deleteFrom = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(deleteFrom, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
			this.setCursorCol(deleteFrom);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordForward(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, merge with next line (delete the newline)
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (forward deletion = append)
				this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
				this.state.lines[this.state.cursorLine] = currentLine + nextLine;
				this.state.lines.splice(this.state.cursorLine + 1, 1);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordForwards resets it)
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordForwards();
			const deleteTo = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(this.state.cursorCol, deleteTo);
			this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, this.state.cursorCol) + currentLine.slice(deleteTo);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private handleForwardDelete(): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Delete grapheme at cursor position (handles emojis, combining characters, etc.)
			const afterCursor = currentLine.slice(this.state.cursorCol);

			// Find the first grapheme at cursor
			const graphemes = [...this.segment(afterCursor)];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + graphemeLength);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after forward delete
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// @ file reference context
			else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Build a mapping from visual lines to logical positions.
	 * Returns an array where each element represents a visual line with:
	 * - logicalLine: index into this.state.lines
	 * - startCol: starting column in the logical line
	 * - length: length of this visual line segment
	 */
	private buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const lineVisWidth = visibleWidth(line);
			if (line.length === 0) {
				// Empty line still takes one visual line
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
			} else if (lineVisWidth <= width) {
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
			} else {
				// Line needs wrapping - use word-aware wrapping
				const chunks = wordWrapLine(line, width, [...this.segment(line)]);
				for (const chunk of chunks) {
					visualLines.push({
						logicalLine: i,
						startCol: chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		return visualLines;
	}

	/**
	 * Find the visual line index for the current cursor position.
	 */
	private findCurrentVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
	): number {
		for (let i = 0; i < visualLines.length; i++) {
			const vl = visualLines[i];
			if (!vl) continue;
			if (vl.logicalLine === this.state.cursorLine) {
				const colInSegment = this.state.cursorCol - vl.startCol;
				// Cursor is in this segment if it's within range
				// For the last segment of a logical line, cursor can be at length (end position)
				const isLastSegmentOfLine =
					i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
				if (colInSegment >= 0 && (colInSegment < vl.length || (isLastSegmentOfLine && colInSegment <= vl.length))) {
					return i;
				}
			}
		}
		// Fallback: return last visual line
		return visualLines.length - 1;
	}

	private moveCursor(deltaLine: number, deltaCol: number): void {
		this.lastAction = null;
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);

		if (deltaLine !== 0) {
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";

			if (deltaCol > 0) {
				// Moving right - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.state.cursorCol < currentLine.length) {
					const afterCursor = currentLine.slice(this.state.cursorCol);
					const graphemes = [...this.segment(afterCursor)];
					const firstGrapheme = graphemes[0];
					this.setCursorCol(this.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
				} else if (this.state.cursorLine < this.state.lines.length - 1) {
					// Wrap to start of next logical line
					this.state.cursorLine++;
					this.setCursorCol(0);
				} else {
					// At end of last line - can't move, but set preferredVisualCol for up/down navigation
					const currentVL = visualLines[currentVisualLine];
					if (currentVL) {
						this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
					}
				}
			} else {
				// Moving left - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.state.cursorCol > 0) {
					const beforeCursor = currentLine.slice(0, this.state.cursorCol);
					const graphemes = [...this.segment(beforeCursor)];
					const lastGrapheme = graphemes[graphemes.length - 1];
					this.setCursorCol(this.state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
				} else if (this.state.cursorLine > 0) {
					// Wrap to end of previous logical line
					this.state.cursorLine--;
					const prevLine = this.state.lines[this.state.cursorLine] || "";
					this.setCursorCol(prevLine.length);
				}
			}
		}
	}

	/**
	 * Scroll by a page (direction: -1 for up, 1 for down).
	 * Moves cursor by the page size while keeping it in bounds.
	 */
	private pageScroll(direction: -1 | 1): void {
		this.lastAction = null;
		const terminalRows = this.tui.terminal.rows;
		const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * pageSize));

		this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	private moveWordBackwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, move to end of previous line
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				const prevLine = this.state.lines[this.state.cursorLine] || "";
				this.setCursorCol(prevLine.length);
			}
			return;
		}

		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		const graphemes = [...this.segment(textBeforeCursor)];
		let newCol = this.state.cursorCol;

		// Skip trailing whitespace
		while (
			graphemes.length > 0 &&
			!isPasteMarker(graphemes[graphemes.length - 1]?.segment || "") &&
			isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "")
		) {
			newCol -= graphemes.pop()?.segment.length || 0;
		}

		if (graphemes.length > 0) {
			const lastGrapheme = graphemes[graphemes.length - 1]?.segment || "";
			if (isPasteMarker(lastGrapheme)) {
				// Paste marker is a single atomic word
				newCol -= graphemes.pop()?.segment.length || 0;
			} else if (isPunctuationChar(lastGrapheme)) {
				// Skip punctuation run
				while (
					graphemes.length > 0 &&
					isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "") &&
					!isPasteMarker(graphemes[graphemes.length - 1]?.segment || "")
				) {
					newCol -= graphemes.pop()?.segment.length || 0;
				}
			} else {
				// Skip word run
				while (
					graphemes.length > 0 &&
					!isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "") &&
					!isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "") &&
					!isPasteMarker(graphemes[graphemes.length - 1]?.segment || "")
				) {
					newCol -= graphemes.pop()?.segment.length || 0;
				}
			}
		}

		this.setCursorCol(newCol);
	}

	/**
	 * Yank (paste) the most recent kill ring entry at cursor position.
	 */
	private yank(): void {
		if (this.killRing.length === 0) return;

		this.pushUndoSnapshot();

		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Cycle through kill ring (only works immediately after yank or yank-pop).
	 * Replaces the last yanked text with the previous entry in the ring.
	 */
	private yankPop(): void {
		// Only works if we just yanked and have more than one entry
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndoSnapshot();

		// Delete the previously yanked text (still at end of ring before rotation)
		this.deleteYankedText();

		// Rotate the ring: move end to front
		this.killRing.rotate();

		// Insert the new most recent entry (now at end after rotation)
		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Insert text at cursor position (used by yank operations).
	 */
	private insertYankedText(text: string): void {
		this.historyIndex = -1; // Exit history browsing mode
		const lines = text.split("\n");

		if (lines.length === 1) {
			// Single line - insert at cursor
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + text + after;
			this.setCursorCol(this.state.cursorCol + text.length);
		} else {
			// Multi-line insert
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);

			// First line merges with text before cursor
			this.state.lines[this.state.cursorLine] = before + (lines[0] || "");

			// Insert middle lines
			for (let i = 1; i < lines.length - 1; i++) {
				this.state.lines.splice(this.state.cursorLine + i, 0, lines[i] || "");
			}

			// Last line merges with text after cursor
			const lastLineIndex = this.state.cursorLine + lines.length - 1;
			this.state.lines.splice(lastLineIndex, 0, (lines[lines.length - 1] || "") + after);

			// Update cursor position
			this.state.cursorLine = lastLineIndex;
			this.setCursorCol((lines[lines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * Delete the previously yanked text (used by yank-pop).
	 * The yanked text is derived from killRing[end] since it hasn't been rotated yet.
	 */
	private deleteYankedText(): void {
		const yankedText = this.killRing.peek();
		if (!yankedText) return;

		const yankLines = yankedText.split("\n");

		if (yankLines.length === 1) {
			// Single line - delete backward from cursor
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const deleteLen = yankedText.length;
			const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - deleteLen);
		} else {
			// Multi-line delete - cursor is at end of last yanked line
			const startLine = this.state.cursorLine - (yankLines.length - 1);
			const startCol = (this.state.lines[startLine] || "").length - (yankLines[0] || "").length;

			// Get text after cursor on current line
			const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(this.state.cursorCol);

			// Get text before yank start position
			const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);

			// Remove all lines from startLine to cursorLine and replace with merged line
			this.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);

			// Update cursor
			this.state.cursorLine = startLine;
			this.setCursorCol(startCol);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private pushUndoSnapshot(): void {
		this.undoStack.push(this.state);
	}

	private undo(): void {
		this.historyIndex = -1; // Exit history browsing mode
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		Object.assign(this.state, snapshot);
		this.lastAction = null;
		this.preferredVisualCol = null;
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * Jump to the first occurrence of a character in the specified direction.
	 * Multi-line search. Case-sensitive. Skips the current cursor position.
	 */
	private jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.lastAction = null;
		const isForward = direction === "forward";
		const lines = this.state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.state.cursorLine;

			// Current line: start after/before cursor; other lines: search full line
			const searchFrom = isCurrentLine
				? isForward
					? this.state.cursorCol + 1
					: this.state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.state.cursorLine = lineIdx;
				this.setCursorCol(idx);
				return;
			}
		}
		// No match found - cursor stays in place
	}

	private moveWordForwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, move to start of next line
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine++;
				this.setCursorCol(0);
			}
			return;
		}

		const textAfterCursor = currentLine.slice(this.state.cursorCol);
		const segments = this.segment(textAfterCursor);
		const iterator = segments[Symbol.iterator]();
		let next = iterator.next();
		let newCol = this.state.cursorCol;

		// Skip leading whitespace
		while (!next.done && !isPasteMarker(next.value.segment) && isWhitespaceChar(next.value.segment)) {
			newCol += next.value.segment.length;
			next = iterator.next();
		}

		if (!next.done) {
			const firstGrapheme = next.value.segment;
			if (isPasteMarker(firstGrapheme)) {
				// Paste marker is a single atomic word
				newCol += firstGrapheme.length;
			} else if (isPunctuationChar(firstGrapheme)) {
				// Skip punctuation run
				while (!next.done && isPunctuationChar(next.value.segment) && !isPasteMarker(next.value.segment)) {
					newCol += next.value.segment.length;
					next = iterator.next();
				}
			} else {
				// Skip word run
				while (
					!next.done &&
					!isWhitespaceChar(next.value.segment) &&
					!isPunctuationChar(next.value.segment) &&
					!isPasteMarker(next.value.segment)
				) {
					newCol += next.value.segment.length;
					next = iterator.next();
				}
			}
		}

		this.setCursorCol(newCol);
	}

	// Slash menu only allowed on the first line of the editor
	private isSlashMenuAllowed(): boolean {
		return this.state.cursorLine === 0;
	}

	// Helper method to check if cursor is at start of message (for slash command detection)
	private isAtStartOfMessage(): boolean {
		if (!this.isSlashMenuAllowed()) return false;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	private isInSlashCommandContext(textBeforeCursor: string): boolean {
		return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
	}

	// Autocomplete methods
	/**
	 * Find the best autocomplete item index for the given prefix.
	 * Returns -1 if no match is found.
	 *
	 * Match priority:
	 * 1. Exact match (prefix === item.value) -> always selected
	 * 2. Prefix match -> first item whose value starts with prefix
	 * 3. No match -> -1 (keep default highlight)
	 *
	 * Matching is case-sensitive and checks item.value only.
	 */
	private getBestAutocompleteMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
		if (!prefix) return -1;

		let firstPrefixIndex = -1;

		for (let i = 0; i < items.length; i++) {
			const value = items[i]!.value;
			if (value === prefix) {
				return i; // Exact match always wins
			}
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				firstPrefixIndex = i;
			}
		}

		return firstPrefixIndex;
	}

	private createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		return new SelectList(items, this.autocompleteMaxVisible, this.theme.selectList, layout);
	}

	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: false, explicitTab });
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete(true);
		}
	}

	private handleSlashCommandCompletion(): void {
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	private forceFileAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: true, explicitTab });
	}

	private requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void {
		if (!this.autocompleteProvider) return;

		if (options.force) {
			const provider = this.autocompleteProvider as CombinedAutocompleteProvider;
			const shouldTrigger =
				!provider.shouldTriggerFileCompletion ||
				provider.shouldTriggerFileCompletion(this.state.lines, this.state.cursorLine, this.state.cursorCol);
			if (!shouldTrigger) {
				return;
			}
		}

		this.cancelAutocompleteRequest();
		const startToken = ++this.autocompleteStartToken;

		const debounceMs = this.getAutocompleteDebounceMs(options);
		if (debounceMs > 0) {
			this.autocompleteDebounceTimer = setTimeout(() => {
				this.autocompleteDebounceTimer = undefined;
				void this.startAutocompleteRequest(startToken, options);
			}, debounceMs);
			return;
		}

		void this.startAutocompleteRequest(startToken, options);
	}

	private async startAutocompleteRequest(
		startToken: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		const previousTask = this.autocompleteRequestTask;
		this.autocompleteRequestTask = (async () => {
			await previousTask;
			if (startToken !== this.autocompleteStartToken || !this.autocompleteProvider) {
				return;
			}

			const controller = new AbortController();
			this.autocompleteAbort = controller;
			const requestId = ++this.autocompleteRequestId;
			const snapshotText = this.getText();
			const snapshotLine = this.state.cursorLine;
			const snapshotCol = this.state.cursorCol;

			await this.runAutocompleteRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
		})();
		await this.autocompleteRequestTask;
	}

	private getAutocompleteDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		const isAttachmentContext = /(?:^|[ \t])@(?:"[^"]*|[^\s]*)$/.test(textBeforeCursor);
		return isAttachmentContext ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	private async runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		if (!this.autocompleteProvider) return;

		const suggestions = await this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
			{ signal: controller.signal, force: options.force },
		);

		if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			return;
		}

		this.autocompleteAbort = undefined;

		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			this.cancelAutocomplete();
			this.tui.requestRender();
			return;
		}

		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			const item = suggestions.items[0]!;
			this.pushUndoSnapshot();
			this.lastAction = null;
			const result = this.autocompleteProvider.applyCompletion(
				this.state.lines,
				this.state.cursorLine,
				this.state.cursorCol,
				item,
				suggestions.prefix,
			);
			this.state.lines = result.lines;
			this.state.cursorLine = result.cursorLine;
			this.setCursorCol(result.cursorCol);
			if (this.onChange) this.onChange(this.getText());
			this.tui.requestRender();
			return;
		}

		this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		this.tui.requestRender();
	}

	private isAutocompleteRequestCurrent(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
	): boolean {
		return (
			!controller.signal.aborted &&
			requestId === this.autocompleteRequestId &&
			this.getText() === snapshotText &&
			this.state.cursorLine === snapshotLine &&
			this.state.cursorCol === snapshotCol
		);
	}

	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
	}

	private cancelAutocompleteRequest(): void {
		this.autocompleteStartToken += 1;
		if (this.autocompleteDebounceTimer) {
			clearTimeout(this.autocompleteDebounceTimer);
			this.autocompleteDebounceTimer = undefined;
		}
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
	}

	private clearAutocompleteUi(): void {
		this.autocompleteState = null;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
	}

	private cancelAutocomplete(): void {
		this.cancelAutocompleteRequest();
		this.clearAutocompleteUi();
	}

	public isShowingAutocomplete(): boolean {
		return this.autocompleteState !== null;
	}

	private updateAutocomplete(): void {
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}
}
