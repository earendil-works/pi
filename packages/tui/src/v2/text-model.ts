import { KillRing } from "../kill-ring.ts";
import { UndoStack } from "../undo-stack.ts";
import { getGraphemeSegmenter } from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";
import { Signal } from "./signal.ts";

export interface TextPosition {
	readonly offset: number;
}

export interface TextRange {
	readonly start: number;
	readonly end: number;
}

export interface TextChangeSet {
	readonly previousText: string;
	readonly text: string;
	readonly range: TextRange;
	readonly insertedText: string;
}

export type MoveDirection = "left" | "right" | "wordLeft" | "wordRight" | "lineStart" | "lineEnd" | "up" | "down";

export type KillDirection = "wordBackward" | "wordForward" | "lineStart" | "lineEnd";

export type EditOp =
	| { type: "insert"; text: string }
	| { type: "deleteBackward" }
	| { type: "deleteForward" }
	| { type: "move"; direction: MoveDirection; extend?: boolean }
	| { type: "select"; range: TextRange }
	| { type: "kill"; direction: KillDirection }
	| { type: "yank" }
	| { type: "yankPop" }
	| { type: "undo" }
	| { type: "setText"; text: string; cursor?: number };

interface TextSnapshot {
	text: string;
	cursor: number;
	anchor: number | null;
	preferredColumn: number | null;
}

type LastAction = "kill" | "yank" | "yankPop" | "other";

function clampOffset(text: string, offset: number): number {
	return Math.max(0, Math.min(text.length, Math.trunc(Number.isFinite(offset) ? offset : 0)));
}

function graphemeBoundaries(text: string): number[] {
	const boundaries = [0];
	for (const segment of getGraphemeSegmenter().segment(text)) boundaries.push(segment.index + segment.segment.length);
	return boundaries;
}

function previousGraphemeOffset(text: string, offset: number): number {
	let previous = 0;
	for (const boundary of graphemeBoundaries(text)) {
		if (boundary >= offset) return previous;
		previous = boundary;
	}
	return previous;
}

function nextGraphemeOffset(text: string, offset: number): number {
	for (const boundary of graphemeBoundaries(text)) {
		if (boundary > offset) return boundary;
	}
	return text.length;
}

function lineStartOffset(text: string, offset: number): number {
	if (offset <= 0) return 0;
	return text.lastIndexOf("\n", offset - 1) + 1;
}

function graphemeColumn(text: string, lineStart: number, offset: number): number {
	let column = 0;
	for (const segment of getGraphemeSegmenter().segment(text.slice(lineStart, offset))) {
		if (segment.segment !== "\n") column++;
	}
	return column;
}

function offsetAtGraphemeColumn(text: string, lineStart: number, lineEnd: number, column: number): number {
	let offset = lineStart;
	let current = 0;
	for (const segment of getGraphemeSegmenter().segment(text.slice(lineStart, lineEnd))) {
		if (current >= column) break;
		offset += segment.segment.length;
		current++;
	}
	return offset;
}

/** Headless grapheme-aware editor state with v1 kill-ring, undo, and word-navigation primitives. */
export class TextModel {
	readonly onChange = new Signal<TextChangeSet>();
	private value: string;
	private cursorOffset: number;
	private selectionAnchor: number | null = null;
	private preferredColumn: number | null = null;
	private readonly killRing: KillRing;
	private readonly undoStack: UndoStack<TextSnapshot>;
	private lastAction: LastAction = "other";
	private yankRange: TextRange | null = null;

	constructor(text = "", cursor = text.length, killRing = new KillRing(), undoStack = new UndoStack<TextSnapshot>()) {
		this.value = text;
		this.cursorOffset = clampOffset(text, cursor);
		this.killRing = killRing;
		this.undoStack = undoStack;
	}

	text(): string {
		return this.value;
	}

	cursor(): TextPosition {
		return { offset: this.cursorOffset };
	}

	selection(): TextRange | null {
		if (this.selectionAnchor === null || this.selectionAnchor === this.cursorOffset) return null;
		return {
			start: Math.min(this.selectionAnchor, this.cursorOffset),
			end: Math.max(this.selectionAnchor, this.cursorOffset),
		};
	}

	apply(op: EditOp): void {
		switch (op.type) {
			case "insert":
				this.replaceSelection(op.text, true);
				this.finishAction("other");
				break;
			case "deleteBackward":
				this.delete(false);
				break;
			case "deleteForward":
				this.delete(true);
				break;
			case "move":
				this.move(op.direction, op.extend ?? false);
				break;
			case "select":
				this.selectionAnchor = clampOffset(this.value, op.range.start);
				this.cursorOffset = clampOffset(this.value, op.range.end);
				this.preferredColumn = null;
				this.finishAction("other");
				break;
			case "kill":
				this.kill(op.direction);
				break;
			case "yank":
				this.yank();
				break;
			case "yankPop":
				this.yankPop();
				break;
			case "undo":
				this.undo();
				break;
			case "setText":
				this.pushUndo();
				this.replaceRange({ start: 0, end: this.value.length }, op.text);
				this.cursorOffset = clampOffset(this.value, op.cursor ?? this.value.length);
				this.selectionAnchor = null;
				this.preferredColumn = null;
				this.finishAction("other");
				break;
		}
	}

	private snapshot(): TextSnapshot {
		return {
			text: this.value,
			cursor: this.cursorOffset,
			anchor: this.selectionAnchor,
			preferredColumn: this.preferredColumn,
		};
	}

	private pushUndo(): void {
		this.undoStack.push(this.snapshot());
	}

	private replaceSelection(text: string, recordUndo: boolean): TextRange {
		const range = this.selection() ?? { start: this.cursorOffset, end: this.cursorOffset };
		if (recordUndo) this.pushUndo();
		this.replaceRange(range, text);
		this.cursorOffset = range.start + text.length;
		this.selectionAnchor = null;
		this.preferredColumn = null;
		return { start: range.start, end: this.cursorOffset };
	}

	private replaceRange(range: TextRange, text: string): void {
		const start = clampOffset(this.value, Math.min(range.start, range.end));
		const end = clampOffset(this.value, Math.max(range.start, range.end));
		const previousText = this.value;
		this.value = previousText.slice(0, start) + text + previousText.slice(end);
		this.onChange.emit({ previousText, text: this.value, range: { start, end }, insertedText: text });
	}

	private delete(forward: boolean): void {
		const selection = this.selection();
		if (selection) {
			this.pushUndo();
			this.replaceRange(selection, "");
			this.cursorOffset = selection.start;
			this.selectionAnchor = null;
		} else {
			const target = forward
				? nextGraphemeOffset(this.value, this.cursorOffset)
				: previousGraphemeOffset(this.value, this.cursorOffset);
			if (target === this.cursorOffset) return;
			this.pushUndo();
			const range = forward ? { start: this.cursorOffset, end: target } : { start: target, end: this.cursorOffset };
			this.replaceRange(range, "");
			this.cursorOffset = range.start;
		}
		this.preferredColumn = null;
		this.finishAction("other");
	}

	private move(direction: MoveDirection, extend: boolean): void {
		const oldCursor = this.cursorOffset;
		let next = oldCursor;
		switch (direction) {
			case "left":
				next = previousGraphemeOffset(this.value, oldCursor);
				break;
			case "right":
				next = nextGraphemeOffset(this.value, oldCursor);
				break;
			case "wordLeft":
				next = findWordBackward(this.value, oldCursor);
				break;
			case "wordRight":
				next = findWordForward(this.value, oldCursor);
				break;
			case "lineStart":
				next = lineStartOffset(this.value, oldCursor);
				break;
			case "lineEnd": {
				const newline = this.value.indexOf("\n", oldCursor);
				next = newline === -1 ? this.value.length : newline;
				break;
			}
			case "up":
			case "down":
				next = this.verticalOffset(direction);
				break;
		}
		if (direction !== "up" && direction !== "down") this.preferredColumn = null;
		if (extend) {
			this.selectionAnchor ??= oldCursor;
		} else {
			this.selectionAnchor = null;
		}
		this.cursorOffset = clampOffset(this.value, next);
		this.finishAction("other");
	}

	private verticalOffset(direction: "up" | "down"): number {
		const currentStart = lineStartOffset(this.value, this.cursorOffset);
		const currentEndIndex = this.value.indexOf("\n", this.cursorOffset);
		const currentEnd = currentEndIndex === -1 ? this.value.length : currentEndIndex;
		this.preferredColumn ??= graphemeColumn(this.value, currentStart, this.cursorOffset);
		if (direction === "up") {
			if (currentStart === 0) return this.cursorOffset;
			const previousEnd = currentStart - 1;
			const previousStart = lineStartOffset(this.value, previousEnd);
			return offsetAtGraphemeColumn(this.value, previousStart, previousEnd, this.preferredColumn);
		}
		if (currentEnd === this.value.length) return this.cursorOffset;
		const nextStart = currentEnd + 1;
		const nextEndIndex = this.value.indexOf("\n", nextStart);
		const nextEnd = nextEndIndex === -1 ? this.value.length : nextEndIndex;
		return offsetAtGraphemeColumn(this.value, nextStart, nextEnd, this.preferredColumn);
	}

	private kill(direction: KillDirection): void {
		let range = this.selection();
		let prepend = false;
		if (!range) {
			switch (direction) {
				case "wordBackward":
					range = { start: findWordBackward(this.value, this.cursorOffset), end: this.cursorOffset };
					prepend = true;
					break;
				case "wordForward":
					range = { start: this.cursorOffset, end: findWordForward(this.value, this.cursorOffset) };
					break;
				case "lineStart":
					range = {
						start: lineStartOffset(this.value, this.cursorOffset),
						end: this.cursorOffset,
					};
					prepend = true;
					break;
				case "lineEnd": {
					const newline = this.value.indexOf("\n", this.cursorOffset);
					range = { start: this.cursorOffset, end: newline === -1 ? this.value.length : newline };
					break;
				}
			}
		}
		if (range.start === range.end) return;
		const killed = this.value.slice(range.start, range.end);
		this.pushUndo();
		this.killRing.push(killed, { prepend, accumulate: this.lastAction === "kill" });
		this.replaceRange(range, "");
		this.cursorOffset = range.start;
		this.selectionAnchor = null;
		this.preferredColumn = null;
		this.finishAction("kill");
	}

	private yank(): void {
		const text = this.killRing.peek();
		if (!text) return;
		this.yankRange = this.replaceSelection(text, true);
		this.finishAction("yank", true);
	}

	private yankPop(): void {
		if (
			(this.lastAction !== "yank" && this.lastAction !== "yankPop") ||
			!this.yankRange ||
			this.killRing.length < 2
		) {
			return;
		}
		this.pushUndo();
		this.killRing.rotate();
		const text = this.killRing.peek();
		if (!text) return;
		const start = this.yankRange.start;
		this.replaceRange(this.yankRange, text);
		this.cursorOffset = start + text.length;
		this.yankRange = { start, end: this.cursorOffset };
		this.finishAction("yankPop", true);
	}

	private undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		const previousText = this.value;
		this.value = snapshot.text;
		this.cursorOffset = snapshot.cursor;
		this.selectionAnchor = snapshot.anchor;
		this.preferredColumn = snapshot.preferredColumn;
		this.onChange.emit({
			previousText,
			text: this.value,
			range: { start: 0, end: previousText.length },
			insertedText: this.value,
		});
		this.finishAction("other");
	}

	private finishAction(action: LastAction, preserveYankRange = false): void {
		this.lastAction = action;
		if (!preserveYankRange) this.yankRange = null;
	}
}
