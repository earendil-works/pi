// Ported (core subset) from pi-vimmode (MIT, (c) 2026 pekochan069, /Users/kangtong/Documents/x/pi-vimmode).
// Pure prompt-buffer operations: no TUI, no Pi imports — everything is unit-testable.

import type { CharSearchKind, EditResult, Position, SearchDirection, VimRegister } from "./types.ts";

export function splitText(text: string): string[] {
	const lines = text.split("\n");
	return lines.length === 0 ? [""] : lines;
}

export function joinLines(lines: string[]): string {
	return (lines.length === 0 ? [""] : lines).join("\n");
}

export function clampPosition(lines: string[], position: Position): Position {
	const safeLines = lines.length === 0 ? [""] : lines;
	const line = Math.max(0, Math.min(position.line, safeLines.length - 1));
	const length = safeLines[line]?.length ?? 0;
	const col = Math.max(0, Math.min(position.col, length));
	return { line, col };
}

function comparePositions(a: Position, b: Position): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.col - b.col;
}

function firstNonBlankColumn(line: string): number {
	const match = /\S/.exec(line);
	return match?.index ?? 0;
}

function lineBoundsForPosition(text: string, cursor: Position): { start: number; end: number; line: string } {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	let start = 0;
	for (let index = 0; index < pos.line; index++) start += (lines[index]?.length ?? 0) + 1;
	const line = lines[pos.line] ?? "";
	return { start, end: start + line.length, line };
}

function isWhitespace(char: string | undefined): boolean {
	return char === undefined || /\s/.test(char);
}

function isKeywordWordChar(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function wordKind(char: string | undefined): "keyword" | "punctuation" | "whitespace" {
	if (isWhitespace(char)) return "whitespace";
	return isKeywordWordChar(char) ? "keyword" : "punctuation";
}

function isSameWordKind(left: string | undefined, right: string | undefined): boolean {
	const leftKind = wordKind(left);
	return leftKind !== "whitespace" && leftKind === wordKind(right);
}

function nextWordStartOffset(text: string, offset: number): number {
	let index = Math.max(0, Math.min(offset, text.length));
	if (index >= text.length) return index;
	if (wordKind(text[index]) !== "whitespace") {
		const kind = wordKind(text[index]);
		while (index < text.length && wordKind(text[index]) === kind) index++;
	}
	while (index < text.length && isWhitespace(text[index])) index++;
	return index;
}

function skipWhitespace(text: string, index: number): number {
	while (index < text.length && isWhitespace(text[index])) index++;
	return index;
}

function boundaryEndOffset(text: string, index: number): number {
	const kind = wordKind(text[index]);
	while (index + 1 < text.length && wordKind(text[index + 1]) === kind) index++;
	return index;
}

function wordEndOffset(text: string, offset: number): number {
	let index = Math.max(0, Math.min(offset, text.length));
	if (index >= text.length) return text.length;
	if (isWhitespace(text[index])) index = skipWhitespace(text, index);
	else if (isSameWordKind(text[index], text[index + 1])) return boundaryEndOffset(text, index);
	else index++;
	if (index >= text.length) return text.length;
	index = skipWhitespace(text, index);
	return index >= text.length ? text.length : boundaryEndOffset(text, index);
}

function previousWordStartOffset(text: string, offset: number): number {
	let index = Math.max(0, Math.min(offset, text.length));
	if (index === 0) return 0;
	index--;
	while (index > 0 && isWhitespace(text[index])) index--;
	const kind = wordKind(text[index]);
	while (index > 0 && wordKind(text[index - 1]) === kind) index--;
	return index;
}

export function positionToOffset(text: string, position: Position): number {
	const lines = splitText(text);
	const pos = clampPosition(lines, position);
	let offset = 0;
	for (let index = 0; index < pos.line; index++) offset += (lines[index]?.length ?? 0) + 1;
	return offset + pos.col;
}

export function offsetToPosition(text: string, offset: number): Position {
	const safeOffset = Math.max(0, Math.min(offset, text.length));
	const lines = splitText(text);
	let consumed = 0;
	for (let line = 0; line < lines.length; line++) {
		const length = lines[line]?.length ?? 0;
		if (safeOffset <= consumed + length) return { line, col: safeOffset - consumed };
		consumed += length + 1;
	}
	const lastLine = Math.max(0, lines.length - 1);
	return { line: lastLine, col: lines[lastLine]?.length ?? 0 };
}

function orderedOffsetRange(start: number, end: number): { start: number; end: number } | undefined {
	const ordered = { start: Math.min(start, end), end: Math.max(start, end) };
	return ordered.start === ordered.end ? undefined : ordered;
}

/** Target offset for a single (count=1) characterwise motion step. */
function motionTargetOffset(text: string, offset: number, motion: string): number {
	const cursor = offsetToPosition(text, offset);
	const bounds = lineBoundsForPosition(text, cursor);
	switch (motion) {
		case "right":
			return Math.min(text.length, offset + 1);
		case "left":
			return Math.max(0, offset - 1);
		case "lineEnd":
			return bounds.end;
		case "lineStart":
			return bounds.start;
		case "firstNonBlank":
			return bounds.start + firstNonBlankColumn(bounds.line);
		case "wordForward":
			return nextWordStartOffset(text, offset);
		case "wordEnd":
			return wordEndOffset(text, offset);
		case "wordBackward":
			return previousWordStartOffset(text, offset);
		default:
			return offset;
	}
}

/**
 * Offset range [start, end) an operator acting on `motion` with `count` would cover.
 * Vim range semantics: `e` is end-inclusive (range extends one past the target), `l` is
 * end-exclusive, everything else is min..max.
 */
export function motionOffsetRange(
	text: string,
	cursor: Position,
	motion: string,
	count = 1,
): { start: number; end: number } | undefined {
	const current = positionToOffset(text, cursor);
	let target = current;
	for (let index = 0; index < Math.max(1, count); index++) {
		const next = motionTargetOffset(text, target, motion);
		if (next === target) break;
		target = next;
	}
	if (motion === "wordEnd" && target >= current) return orderedOffsetRange(current, Math.min(text.length, target + 1));
	if (motion === "right" && target >= current) return orderedOffsetRange(current, Math.min(text.length, target));
	return orderedOffsetRange(current, target);
}

/** Linewise range for j/k motions, or undefined when the motion does not move. */
function motionLineRange(
	text: string,
	cursor: Position,
	motion: string,
	count = 1,
): { startLine: number; endLine: number } | undefined {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	const lastLine = Math.max(0, lines.length - 1);
	if (motion === "down") {
		const target = Math.min(lastLine, pos.line + Math.max(1, count));
		return target === pos.line ? undefined : { startLine: pos.line, endLine: target };
	}
	if (motion === "up") {
		const target = Math.max(0, pos.line - Math.max(1, count));
		return target === pos.line ? undefined : { startLine: target, endLine: pos.line };
	}
	return undefined;
}

export function deleteOffsetRange(text: string, start: number, end: number): EditResult {
	const range = orderedOffsetRange(start, end);
	if (!range) return { text, cursor: offsetToPosition(text, start), changed: false };
	const removed = text.slice(range.start, range.end);
	if (removed.length === 0) return { text, cursor: offsetToPosition(text, range.start), changed: false };
	const nextText = text.slice(0, range.start) + text.slice(range.end);
	return {
		text: nextText,
		cursor: offsetToPosition(nextText, range.start),
		register: { type: "char", text: removed },
		changed: nextText !== text,
	};
}

/** Delete an inclusive position range (used by x and visual charwise operations). */
export function deleteRange(text: string, start: Position, end: Position): EditResult {
	return deleteOffsetRange(text, positionToOffset(text, start), positionToOffset(text, end) + 1);
}

// ── visual selection helpers ──

export function normalizeRange(
	lines: string[],
	anchor: Position,
	active: Position,
): { start: Position; end: Position } {
	const a = clampPosition(lines, anchor);
	const b = clampPosition(lines, active);
	return comparePositions(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a };
}

export function normalizeLineRange(
	lines: string[],
	anchor: Position,
	active: Position,
): { startLine: number; endLine: number } {
	const a = clampPosition(lines, anchor);
	const b = clampPosition(lines, active);
	return { startLine: Math.min(a.line, b.line), endLine: Math.max(a.line, b.line) };
}

/** Selected text for a charwise visual range; the end position is inclusive. */
export function selectionText(text: string, anchor: Position, active: Position): string {
	const lines = splitText(text);
	const range = normalizeRange(lines, anchor, active);
	const { start, end } = range;
	if (start.line === end.line) {
		const line = lines[start.line] ?? "";
		return line.slice(start.col, Math.min(end.col + 1, line.length));
	}
	const selected: string[] = [];
	selected.push((lines[start.line] ?? "").slice(start.col));
	for (let line = start.line + 1; line < end.line; line++) selected.push(lines[line] ?? "");
	const last = lines[end.line] ?? "";
	selected.push(last.slice(0, Math.min(end.col + 1, last.length)));
	return selected.join("\n");
}

export function linewiseSelectionText(text: string, anchor: Position, active: Position): string {
	const lines = splitText(text);
	const range = normalizeLineRange(lines, anchor, active);
	return lines.slice(range.startLine, range.endLine + 1).join("\n");
}

/** Delete a charwise visual selection (inclusive end). */
export function deleteVisualChars(text: string, anchor: Position, active: Position): EditResult {
	const lines = splitText(text);
	const range = normalizeRange(lines, anchor, active);
	const selected = selectionText(text, anchor, active);
	if (selected.length === 0) return { text, cursor: clampPosition(lines, anchor), changed: false };
	return deleteOffsetRange(
		text,
		positionToOffset(text, range.start),
		Math.min(text.length, positionToOffset(text, range.end) + 1),
	);
}

/** Delete a linewise visual selection. */
export function deleteVisualLines(text: string, anchor: Position, active: Position): EditResult {
	return deleteLineRange(text, anchor, active);
}

export function deleteLineRange(text: string, anchor: Position, active: Position): EditResult {
	const lines = splitText(text);
	const range = normalizeLineRange(lines, anchor, active);
	const selected = linewiseSelectionText(text, anchor, active);
	if (lines.length === 1) {
		return {
			text: "",
			cursor: { line: 0, col: 0 },
			register: { type: "line", text: selected },
			changed: text !== "",
		};
	}
	let nextLines = [...lines.slice(0, range.startLine), ...lines.slice(range.endLine + 1)];
	if (nextLines.length === 0) nextLines = [""];
	const cursorLine = Math.min(range.startLine, nextLines.length - 1);
	const nextText = joinLines(nextLines);
	return {
		text: nextText,
		cursor: { line: cursorLine, col: 0 },
		register: { type: "line", text: selected },
		changed: nextText !== text,
	};
}

/** Replace every character of a charwise/linewise visual selection with `char` (r in visual). */
export function replaceVisualRange(
	text: string,
	anchor: Position,
	active: Position,
	linewise: boolean,
	char: string,
): EditResult {
	const lines = splitText(text);
	if (!char || char === "\n") return { text, cursor: clampPosition(lines, anchor), changed: false };
	if (linewise) {
		const range = normalizeLineRange(lines, anchor, active);
		const selected = linewiseSelectionText(text, anchor, active);
		const nextLines = lines.map((line, index) =>
			index >= range.startLine && index <= range.endLine ? char.repeat(line.length) : line,
		);
		const nextText = joinLines(nextLines);
		return {
			text: nextText,
			cursor: { line: range.startLine, col: 0 },
			register: selected ? { type: "line", text: selected } : undefined,
			changed: nextText !== text,
		};
	}
	const range = normalizeRange(lines, anchor, active);
	const selected = selectionText(text, anchor, active);
	const nextLines = lines.map((line, index) => {
		if (index < range.start.line || index > range.end.line) return line;
		const start = index === range.start.line ? Math.min(range.start.col, line.length) : 0;
		const end = index === range.end.line ? Math.min(range.end.col + 1, line.length) : line.length;
		return line.slice(0, start) + char.repeat(end - start) + line.slice(end);
	});
	const nextText = joinLines(nextLines);
	return {
		text: nextText,
		cursor: clampPosition(nextLines, range.start),
		register: selected ? { type: "char", text: selected } : undefined,
		changed: nextText !== text,
	};
}

// ── operator + motion compositions ──

export function deleteByMotion(text: string, cursor: Position, motion: string, count = 1): EditResult {
	const lineRange = motionLineRange(text, cursor, motion, count);
	if (lineRange) {
		return deleteLineRange(text, { line: lineRange.startLine, col: 0 }, { line: lineRange.endLine, col: 0 });
	}
	const range = motionOffsetRange(text, cursor, motion, count);
	if (!range) return { text, cursor: clampPosition(splitText(text), cursor), changed: false };
	return deleteOffsetRange(text, range.start, range.end);
}

export function yankByMotion(text: string, cursor: Position, motion: string, count = 1): VimRegister | undefined {
	const lineRange = motionLineRange(text, cursor, motion, count);
	if (lineRange) {
		return {
			type: "line",
			text: linewiseSelectionText(text, { line: lineRange.startLine, col: 0 }, { line: lineRange.endLine, col: 0 }),
		};
	}
	const range = motionOffsetRange(text, cursor, motion, count);
	if (!range) return undefined;
	const selected = text.slice(range.start, range.end);
	return selected.length === 0 ? undefined : { type: "char", text: selected };
}

/**
 * Offset range of the iw/aw text object under `offset`.
 * `inner` covers the word only; `outer` (a word) additionally covers one
 * adjacent whitespace run — trailing preferred, leading at end of line.
 * `count` words are covered, including the whitespace between them.
 */
export function wordObjectRange(
	text: string,
	offset: number,
	inner: boolean,
	count = 1,
): { start: number; end: number } | undefined {
	if (text.length === 0) return undefined;
	let index = Math.max(0, Math.min(offset, text.length - 1));
	// On whitespace, vim targets the next word; past the last word, the previous one.
	if (isWhitespace(text[index])) {
		const next = skipWhitespace(text, index);
		index = next < text.length ? next : previousWordStartOffset(text, text.length);
	}
	const kind = wordKind(text[index]);
	let start = index;
	while (start > 0 && wordKind(text[start - 1]) === kind) start--;
	let end = index;
	while (end < text.length && wordKind(text[end]) === kind) end++;
	for (let step = 1; step < count; step++) {
		const next = skipWhitespace(text, end);
		if (next >= text.length) break;
		const nextKind = wordKind(text[next]);
		end = next;
		while (end < text.length && wordKind(text[end]) === nextKind) end++;
	}
	if (!inner) {
		const trailing = skipWhitespace(text, end);
		if (trailing > end) {
			end = trailing;
		} else {
			while (start > 0 && isWhitespace(text[start - 1])) start--;
		}
	}
	return start === end ? undefined : { start, end };
}

export function deleteLine(text: string, cursor: Position, count = 1): EditResult {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	const endLine = Math.min(lines.length - 1, pos.line + Math.max(1, count) - 1);
	return deleteLineRange(text, pos, { line: endLine, col: 0 });
}

export function changeLine(text: string, cursor: Position, count = 1): EditResult {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	const endLine = Math.min(lines.length - 1, pos.line + Math.max(1, count) - 1);
	const removed = lines.slice(pos.line, endLine + 1).join("\n");
	const nextLines = [...lines.slice(0, pos.line), "", ...lines.slice(endLine + 1)];
	const nextText = joinLines(nextLines);
	return {
		text: nextText,
		cursor: { line: pos.line, col: 0 },
		register: { type: "line", text: removed },
		changed: nextText !== text,
	};
}

export function yankLineCount(text: string, cursor: Position, count = 1): VimRegister {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	const endLine = Math.min(lines.length - 1, pos.line + Math.max(1, count) - 1);
	return { type: "line", text: lines.slice(pos.line, endLine + 1).join("\n") };
}

// ── single-char and line edits ──

export function deleteCharAt(text: string, cursor: Position, count = 1): EditResult {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	const line = lines[pos.line] ?? "";
	if (pos.col >= line.length) return { text, cursor: pos, changed: false };
	const endCol = Math.min(line.length - 1, pos.col + Math.max(1, count) - 1);
	return deleteRange(text, pos, { line: pos.line, col: endCol });
}

export function deleteCharBefore(text: string, cursor: Position, count = 1): EditResult {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	if (pos.col <= 0) return { text, cursor: pos, changed: false };
	const startCol = Math.max(0, pos.col - Math.max(1, count));
	return deleteRange(text, { line: pos.line, col: startCol }, { line: pos.line, col: pos.col - 1 });
}

export function replaceCharAt(text: string, cursor: Position, char: string, count = 1): EditResult {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	const line = lines[pos.line] ?? "";
	if (pos.col >= line.length || char.length === 0 || char === "\n") return { text, cursor: pos, changed: false };
	const length = Math.min(Math.max(1, count), line.length - pos.col);
	const nextLine = line.slice(0, pos.col) + char.repeat(length) + line.slice(pos.col + length);
	const nextLines = [...lines];
	nextLines[pos.line] = nextLine;
	const nextText = joinLines(nextLines);
	return {
		text: nextText,
		cursor: pos,
		register: { type: "char", text: line.slice(pos.col, pos.col + length) },
		changed: nextText !== text,
	};
}

export function openLineBelow(text: string, cursor: Position): EditResult {
	if (text.length === 0) return { text, cursor: { line: 0, col: 0 }, changed: false };
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	const nextLines = [...lines.slice(0, pos.line + 1), "", ...lines.slice(pos.line + 1)];
	return { text: joinLines(nextLines), cursor: { line: pos.line + 1, col: 0 }, changed: true };
}

export function openLineAbove(text: string, cursor: Position): EditResult {
	if (text.length === 0) return { text, cursor: { line: 0, col: 0 }, changed: false };
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	const nextLines = [...lines.slice(0, pos.line), "", ...lines.slice(pos.line)];
	return { text: joinLines(nextLines), cursor: { line: pos.line, col: 0 }, changed: true };
}

export function joinLineWithNext(text: string, cursor: Position): EditResult {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	if (pos.line >= lines.length - 1) return { text, cursor: pos, changed: false };
	const left = (lines[pos.line] ?? "").trimEnd();
	const right = (lines[pos.line + 1] ?? "").trimStart();
	const separator = left.length > 0 && right.length > 0 ? " " : "";
	const joined = `${left}${separator}${right}`;
	const nextLines = [...lines.slice(0, pos.line), joined, ...lines.slice(pos.line + 2)];
	return { text: joinLines(nextLines), cursor: { line: pos.line, col: left.length }, changed: true };
}

// ── paste ──

export function pasteRegister(text: string, cursor: Position, register: VimRegister | undefined): EditResult {
	if (!register || register.text.length === 0) {
		return { text, cursor: clampPosition(splitText(text), cursor), changed: false };
	}
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	if (register.type === "line") {
		const inserted = register.text.split("\n");
		const nextLines = [...lines.slice(0, pos.line + 1), ...inserted, ...lines.slice(pos.line + 1)];
		return { text: joinLines(nextLines), cursor: { line: pos.line + 1, col: 0 }, changed: true };
	}
	const line = lines[pos.line] ?? "";
	const insertCol = line.length === 0 ? 0 : Math.min(pos.col + 1, line.length);
	const before = line.slice(0, insertCol);
	const after = line.slice(insertCol);
	const insertedLines = register.text.split("\n");
	let nextLines: string[];
	let nextCursor: Position;
	if (insertedLines.length === 1) {
		const inserted = insertedLines[0] ?? "";
		nextLines = [...lines];
		nextLines[pos.line] = before + inserted + after;
		nextCursor = { line: pos.line, col: insertCol + inserted.length - 1 };
	} else {
		const firstInserted = insertedLines[0] ?? "";
		const lastInserted = insertedLines[insertedLines.length - 1] ?? "";
		const middle = insertedLines.slice(1, -1);
		nextLines = [
			...lines.slice(0, pos.line),
			before + firstInserted,
			...middle,
			lastInserted + after,
			...lines.slice(pos.line + 1),
		];
		nextCursor = { line: pos.line + insertedLines.length - 1, col: Math.max(0, lastInserted.length - 1) };
	}
	return { text: joinLines(nextLines), cursor: clampPosition(nextLines, nextCursor), changed: true };
}

export function pasteRegisterBefore(text: string, cursor: Position, register: VimRegister | undefined): EditResult {
	if (!register || register.text.length === 0) {
		return { text, cursor: clampPosition(splitText(text), cursor), changed: false };
	}
	if (register.type === "line" && text.length === 0) {
		return { text: register.text, cursor: { line: 0, col: 0 }, changed: true };
	}
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	if (register.type === "line") {
		const inserted = register.text.split("\n");
		const nextLines = [...lines.slice(0, pos.line), ...inserted, ...lines.slice(pos.line)];
		return { text: joinLines(nextLines), cursor: { line: pos.line, col: 0 }, changed: true };
	}
	const line = lines[pos.line] ?? "";
	const insertedLines = register.text.split("\n");
	let nextLines: string[];
	let nextCursor: Position;
	if (insertedLines.length === 1) {
		const inserted = insertedLines[0] ?? "";
		nextLines = [...lines];
		nextLines[pos.line] = line.slice(0, pos.col) + inserted + line.slice(pos.col);
		nextCursor = { line: pos.line, col: pos.col + inserted.length - 1 };
	} else {
		const firstInserted = insertedLines[0] ?? "";
		const lastInserted = insertedLines[insertedLines.length - 1] ?? "";
		const middle = insertedLines.slice(1, -1);
		nextLines = [
			...lines.slice(0, pos.line),
			line.slice(0, pos.col) + firstInserted,
			...middle,
			lastInserted + line.slice(pos.col),
			...lines.slice(pos.line + 1),
		];
		nextCursor = { line: pos.line + insertedLines.length - 1, col: Math.max(0, lastInserted.length - 1) };
	}
	return { text: joinLines(nextLines), cursor: clampPosition(nextLines, nextCursor), changed: true };
}

// ── character search (f/F/t/T) ──

function charSearchMatchColumn(
	line: string,
	cursorCol: number,
	kind: CharSearchKind,
	target: string,
	count = 1,
): number | undefined {
	if (target.length !== 1 || target === "\n") return undefined;
	const forward = kind === "findForward" || kind === "tillForward";
	let remaining = Math.max(1, count);
	if (forward) {
		for (let index = cursorCol + 1; index < line.length; index++) {
			if (line[index] === target && --remaining === 0) return index;
		}
		return undefined;
	}
	for (let index = cursorCol - 1; index >= 0; index--) {
		if (line[index] === target && --remaining === 0) return index;
	}
	return undefined;
}

/** Target cursor position for f/F/t/T on the current line. */
export function findCharOnLine(
	text: string,
	cursor: Position,
	kind: CharSearchKind,
	target: string,
	count = 1,
): Position | undefined {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	const found = charSearchMatchColumn(lines[pos.line] ?? "", pos.col, kind, target, count);
	if (found === undefined) return undefined;
	const offset = kind === "tillForward" ? -1 : kind === "tillBackward" ? 1 : 0;
	return { line: pos.line, col: Math.max(0, Math.min((lines[pos.line] ?? "").length, found + offset)) };
}

/** Offset range an operator + f/F/t/T char search would cover. */
export function charSearchOperatorOffsetRange(
	text: string,
	cursor: Position,
	kind: CharSearchKind,
	target: string,
	count = 1,
): { start: number; end: number } | undefined {
	const found = findCharOnLine(text, cursor, kind, target, count);
	if (!found) return undefined;
	const current = positionToOffset(text, cursor);
	const targetOffset = positionToOffset(text, found);
	const inclusive = kind === "findForward" || kind === "findBackward";
	const end = inclusive ? targetOffset + 1 : targetOffset;
	return orderedOffsetRange(current, Math.min(text.length, end));
}

// ── prompt search (/ ? n N) — literal, case-sensitive, wrapping ──

/** Next match position after/before the cursor, wrapping around the buffer. */
export function findSearchMatch(
	text: string,
	cursor: Position,
	query: string,
	direction: SearchDirection = "forward",
): Position | undefined {
	if (query.length === 0 || query.includes("\n")) return undefined;
	const start = positionToOffset(text, cursor);
	if (direction === "forward") {
		const later = text.indexOf(query, Math.min(text.length, start + 1));
		if (later >= 0) return offsetToPosition(text, later);
		const wrapped = text.indexOf(query, 0);
		return wrapped >= 0 ? offsetToPosition(text, wrapped) : undefined;
	}
	const earlier = start > 0 ? text.lastIndexOf(query, start - 1) : -1;
	if (earlier >= 0) return offsetToPosition(text, earlier);
	const wrapped = text.lastIndexOf(query);
	return wrapped >= 0 ? offsetToPosition(text, wrapped) : undefined;
}

export function firstNonBlankPosition(text: string, cursor: Position): Position {
	const lines = splitText(text);
	const pos = clampPosition(lines, cursor);
	return { line: pos.line, col: firstNonBlankColumn(lines[pos.line] ?? "") };
}
