// Ported (core subset) from pi-vimmode (MIT, (c) 2026 pekochan069, /Users/kangtong/Documents/x/pi-vimmode).
// Rendering helpers: the bottom-border mode/status line and the minimal visual-selection
// renderer (used only while a visual selection is active — plain modes reuse Editor.render).

import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ModalState, Position, VimMode } from "./types.ts";

const SELECTION_START = "\x1b[7m";
const CURSOR_BLOCK_START = "\x1b[4;7m";
const ANSI_RESET = "\x1b[0m";

/**
 * Bottom-border status line: `─ LEFT ─── RIGHT ─`. Shrinks right first, then left,
 * keeping at least the mode label. Port of pi-vimmode's fitStatusBorder.
 */
export function fitStatusBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string = (text) => text,
): string {
	if (width <= 0) return "";
	if (width <= 2) return border("─".repeat(width));

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = 1;

	while (
		visibleWidth(rightText) > 0 &&
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		visibleWidth(leftText) > 1 &&
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width
	) {
		leftText = truncateToWidth(leftText, Math.max(1, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border("─")}${leftText}${border("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

const MODE_LABELS: Record<VimMode, string> = {
	insert: "-- INSERT --",
	normal: "-- NORMAL --",
	visual: "-- VISUAL --",
	visualLine: "-- V-LINE --",
};

/** `{left, right}` status content for the current modal state. */
export function statusParts(
	state: ModalState,
	snapshot: { text: string; lines: string[]; cursor: Position },
): { left: string; right: string } {
	let left = MODE_LABELS[state.mode];
	if (state.pendingOperator) left = `${left} ${state.pendingOperator}`;
	if (state.pendingReplace) left = `${left} r`;
	if (state.pendingCharSearch) left = `${left} ${state.pendingCharSearch.kind.startsWith("find") ? "f" : "t"}`;
	if (state.pendingSearch)
		left = `${state.pendingSearch.direction === "forward" ? "/" : "?"}${state.pendingSearch.query}`;

	let right = "";
	if (state.count > 0) right = String(state.count);
	const selection = visualSelectionSummary(state, snapshot);
	if (selection) right = right ? `${right} ${selection}` : selection;
	return { left, right };
}

function comparePositions(a: Position, b: Position): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.col - b.col;
}

function visualSelectionSummary(
	state: ModalState,
	snapshot: { lines: string[]; cursor: Position },
): string | undefined {
	if ((state.mode !== "visual" && state.mode !== "visualLine") || !state.visualAnchor) return undefined;
	if (state.mode === "visualLine") {
		const lines = Math.abs(snapshot.cursor.line - state.visualAnchor.line) + 1;
		return `${String(lines)} line${lines === 1 ? "" : "s"}`;
	}
	const start = comparePositions(state.visualAnchor, snapshot.cursor) <= 0 ? state.visualAnchor : snapshot.cursor;
	const end = comparePositions(state.visualAnchor, snapshot.cursor) <= 0 ? snapshot.cursor : state.visualAnchor;
	if (start.line === end.line) {
		const chars = end.col - start.col + 1;
		return `${String(chars)} char${chars === 1 ? "" : "s"}`;
	}
	let chars = 0;
	for (let line = start.line; line <= end.line; line++) {
		const length = snapshot.lines[line]?.length ?? 0;
		if (line === start.line && line === end.line) chars += end.col - start.col + 1;
		else if (line === start.line) chars += length - start.col;
		else if (line === end.line) chars += end.col + 1;
		else chars += length;
	}
	return `${String(chars)} chars`;
}

// ── minimal visual selection renderer ──

type TextChunk = { text: string; startIndex: number; endIndex: number };

type LayoutLine = {
	lineIndex: number;
	text: string;
	startIndex: number;
	endIndex: number;
	isLastChunk: boolean;
};

/** Greedy cell wrap matching pi-tui Editor.layoutText's wrapping. */
function wordWrapLine(line: string, width: number): TextChunk[] {
	const chunks: TextChunk[] = [];
	let current = "";
	let currentStart = 0;
	let currentWidth = 0;
	let offset = 0;
	for (const cell of Array.from(line)) {
		const cellWidth = Math.max(1, visibleWidth(cell));
		if (current.length > 0 && currentWidth + cellWidth > width) {
			chunks.push({ text: current, startIndex: currentStart, endIndex: offset });
			current = "";
			currentStart = offset;
			currentWidth = 0;
		}
		current += cell;
		currentWidth += cellWidth;
		offset += cell.length;
	}
	if (current.length > 0) chunks.push({ text: current, startIndex: currentStart, endIndex: offset });
	return chunks.length === 0 ? [{ text: "", startIndex: 0, endIndex: 0 }] : chunks;
}

function layoutLines(lines: string[], width: number): LayoutLine[] {
	const result: LayoutLine[] = [];
	const safeLines = lines.length === 0 ? [""] : lines;
	for (let lineIndex = 0; lineIndex < safeLines.length; lineIndex++) {
		const chunks = wordWrapLine(safeLines[lineIndex] ?? "", width);
		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
			const chunk = chunks[chunkIndex];
			if (!chunk) continue;
			result.push({
				lineIndex,
				text: chunk.text,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				isLastChunk: chunkIndex === chunks.length - 1,
			});
		}
	}
	return result.length === 0 ? [{ lineIndex: 0, text: "", startIndex: 0, endIndex: 0, isLastChunk: true }] : result;
}

function isCellSelected(
	mode: VimMode,
	anchor: Position | undefined,
	cursor: Position,
	lineIndex: number,
	col: number,
): boolean {
	if (!anchor) return false;
	if (mode === "visualLine") {
		const lo = Math.min(anchor.line, cursor.line);
		const hi = Math.max(anchor.line, cursor.line);
		return lineIndex >= lo && lineIndex <= hi;
	}
	const start = comparePositions(anchor, cursor) <= 0 ? anchor : cursor;
	const end = comparePositions(anchor, cursor) <= 0 ? cursor : anchor;
	if (lineIndex < start.line || lineIndex > end.line) return false;
	if (start.line === end.line) return col >= start.col && col <= end.col;
	if (lineIndex === start.line) return col >= start.col;
	if (lineIndex === end.line) return col <= end.col;
	return true;
}

export type VisualRenderInput = {
	lines: string[];
	cursor: Position;
	anchor: Position;
	mode: Extract<VimMode, "visual" | "visualLine">;
	/** Same width Editor.render was asked for. */
	width: number;
	terminalRows: number;
	focused: boolean;
	scrollOffset: number;
	borderColor: (text: string) => string;
};

export type VisualRenderResult = {
	rows: string[];
	/** Updated viewport offset (keeps the cursor visible). */
	scrollOffset: number;
};

/**
 * Full editor rows (top border, content, bottom border) with the visual selection
 * highlighted. Only used while a selection is active; other modes reuse Editor.render.
 */
export function renderVisualRows(input: VisualRenderInput): VisualRenderResult {
	const { width } = input;
	if (width <= 0) return { rows: [], scrollOffset: input.scrollOffset };
	// Mirror Editor.render: reserve 1 column for the cursor when unpadded.
	const layoutWidth = Math.max(1, width - 1);
	const layout = layoutLines(input.lines, layoutWidth);
	const maxVisibleLines = Math.max(5, Math.floor(input.terminalRows * 0.3));

	let scrollOffset = input.scrollOffset;
	const cursorChunkIndex = (() => {
		for (let index = 0; index < layout.length; index++) {
			const chunk = layout[index];
			if (!chunk) continue;
			if (chunk.lineIndex !== input.cursor.line) continue;
			if (
				chunk.isLastChunk
					? input.cursor.col >= chunk.startIndex
					: input.cursor.col >= chunk.startIndex && input.cursor.col < chunk.endIndex
			)
				return index;
		}
		return 0;
	})();
	if (cursorChunkIndex < scrollOffset) scrollOffset = cursorChunkIndex;
	else if (cursorChunkIndex >= scrollOffset + maxVisibleLines) scrollOffset = cursorChunkIndex - maxVisibleLines + 1;
	scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, layout.length - maxVisibleLines)));

	const visible = layout.slice(scrollOffset, scrollOffset + maxVisibleLines);
	const border = input.borderColor;
	const rows: string[] = [border("─".repeat(width))];
	const marker = input.focused ? CURSOR_MARKER : "";

	for (const chunk of visible) {
		let output = "";
		let renderedWidth = 0;
		let offset = 0;
		let cursorRendered = false;
		while (offset < chunk.text.length) {
			const cell = Array.from(chunk.text.slice(offset))[0] ?? "";
			const cellStart = chunk.startIndex + offset;
			if (input.cursor.line === chunk.lineIndex && input.cursor.col === cellStart) {
				output += `${marker}${CURSOR_BLOCK_START}${cell}${ANSI_RESET}`;
				cursorRendered = true;
			} else if (isCellSelected(input.mode, input.anchor, input.cursor, chunk.lineIndex, cellStart)) {
				output += `${SELECTION_START}${cell}${ANSI_RESET}`;
			} else {
				output += cell;
			}
			renderedWidth += visibleWidth(cell);
			offset += cell.length;
		}
		const cursorAtEnd =
			input.cursor.line === chunk.lineIndex && input.cursor.col >= chunk.endIndex && chunk.isLastChunk;
		if (cursorAtEnd && !cursorRendered) {
			output += `${marker}${CURSOR_BLOCK_START} ${ANSI_RESET}`;
			renderedWidth += 1;
		}
		rows.push(output + " ".repeat(Math.max(0, width - renderedWidth)));
	}

	const linesBelow = layout.length - (scrollOffset + visible.length);
	if (linesBelow > 0) {
		const label = ` ↓ ${String(linesBelow)} more `;
		const labelWidth = visibleWidth(label);
		if (labelWidth + 2 <= width) {
			const leftWidth = Math.floor((width - labelWidth) / 2);
			rows.push(border("─".repeat(leftWidth) + label + "─".repeat(width - leftWidth - labelWidth)));
		} else {
			rows.push(border("─".repeat(width)));
		}
	} else {
		rows.push(border("─".repeat(width)));
	}
	return { rows, scrollOffset };
}
