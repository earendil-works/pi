// Ported (core subset) from pi-vimmode (MIT, (c) 2026 pekochan069, /Users/kangtong/Documents/x/pi-vimmode).
// Pure modal dispatcher: (state, editor snapshot, raw input) -> (next state, effects).
// No TUI objects beyond the snapshot; all buffer mutations are pure EditResults.

import { parseKey } from "@earendil-works/pi-tui";
import {
	changeLine,
	charSearchOperatorOffsetRange,
	clampPosition,
	deleteByMotion,
	deleteCharAt,
	deleteLine,
	deleteOffsetRange,
	deleteVisualChars,
	deleteVisualLines,
	findCharOnLine,
	findSearchMatch,
	firstNonBlankPosition,
	joinLineWithNext,
	linewiseSelectionText,
	motionOffsetRange,
	offsetToPosition,
	openLineAbove,
	openLineBelow,
	pasteRegister,
	pasteRegisterBefore,
	positionToOffset,
	replaceCharAt,
	replaceVisualRange,
	selectionText,
	splitText,
	yankByMotion,
	yankLineCount,
} from "./buffer.ts";
import { type InsertEntry, NORMAL_KEYS, PROTECTED_PI_KEYS, VISUAL_KEYS } from "./keys.ts";
import type {
	EditResult,
	ModalEffect,
	ModalState,
	ModalUpdate,
	OperatorName,
	Position,
	SearchDirection,
	VimMode,
	VimRegister,
} from "./types.ts";

type Snapshot = { text: string; lines: string[]; cursor: Position; isAutocompleteOpen: boolean };

export function createModalState(mode: VimMode = "insert"): ModalState {
	return {
		mode,
		count: 0,
		pendingOperator: undefined,
		pendingOperatorCount: 0,
		pendingCharSearch: undefined,
		pendingReplace: false,
		visualAnchor: undefined,
		register: undefined,
		lastSearch: undefined,
		pendingSearch: undefined,
	};
}

const update = (state: ModalState, effects: ModalEffect[]): ModalUpdate => ({ state, effects });
const invalidate = (state: ModalState): ModalUpdate => update(state, [{ type: "invalidate" }]);
const delegate = (state: ModalState, input: string): ModalUpdate => update(state, [{ type: "delegate", input }]);

/** Reset everything transient (count/operator/char-search/replace) without leaving the mode. */
function clearPending(state: ModalState): ModalState {
	return {
		...state,
		count: 0,
		pendingOperator: undefined,
		pendingOperatorCount: 0,
		pendingCharSearch: undefined,
		pendingReplace: false,
	};
}

function isProtectedKey(keyId: string | undefined): boolean {
	return keyId !== undefined && (PROTECTED_PI_KEYS as readonly string[]).includes(keyId);
}

function isDigit(keyId: string | undefined): keyId is string {
	return keyId !== undefined && /^[0-9]$/.test(keyId);
}

/** Printable characters usable as f/F/t/T targets, r replacements, or search input. */
function printableChar(keyId: string | undefined): string | undefined {
	if (keyId === undefined) return undefined;
	if (keyId === "space") return " ";
	if (keyId.length === 1) return keyId;
	return undefined;
}

function cursorAtLineEnd(snapshot: { lines: string[]; cursor: Position }): boolean {
	return snapshot.cursor.col >= (snapshot.lines[snapshot.cursor.line]?.length ?? 0);
}

/** Motions whose target is the start of the offset range (they move backwards). */
function isBackwardMotion(motion: string): boolean {
	return motion === "left" || motion === "wordBackward" || motion === "lineStart" || motion === "firstNonBlank";
}

/** Compute the destination of a plain motion applied `count` times from `cursor`. */
function motionTargetPosition(text: string, cursor: Position, motion: string, count: number): Position | undefined {
	let target = cursor;
	for (let index = 0; index < count; index++) {
		const range = motionOffsetRange(text, target, motion, 1);
		if (!range) break;
		const offset = isBackwardMotion(motion) ? range.start : range.end - (motion === "wordEnd" ? 1 : 0);
		target = clampPosition(splitText(text), offsetToPosition(text, offset));
	}
	return target;
}

export function handleModalInput(state: ModalState, snapshot: Snapshot, data: string): ModalUpdate {
	const keyId = parseKey(data);

	// While Pi's autocomplete is open, Pi owns every key (menu nav, accept, cancel).
	if (snapshot.isAutocompleteOpen) return delegate(state, data);

	if (state.pendingSearch) return handlePendingSearch(state, snapshot, keyId);
	if (state.pendingCharSearch) return handlePendingCharSearch(state, snapshot, keyId);
	if (state.pendingReplace) return handlePendingReplace(state, snapshot, keyId);

	switch (state.mode) {
		case "insert":
			return handleInsert(state, data, keyId);
		case "normal":
			return handleNormal(state, snapshot, data, keyId);
		case "visual":
		case "visualLine":
			return handleVisual(state, snapshot, data, keyId);
	}
}

// ── insert mode ──

function handleInsert(state: ModalState, data: string, keyId: string | undefined): ModalUpdate {
	if (keyId === "escape") {
		const next = clearPending({ ...state, mode: "normal" });
		// Vim keeps the cursor on the last inserted character when leaving insert.
		return update(next, [{ type: "adapterCommand", command: "left" }]);
	}
	return delegate(state, data);
}

// ── normal mode ──

/** Map terminal navigation keys to their vim equivalents for table lookup. */
function mapNavigationKey(keyId: string | undefined): string | undefined {
	switch (keyId) {
		case "left":
			return "h";
		case "right":
			return "l";
		case "up":
			return "k";
		case "down":
			return "j";
		case "home":
			return "0";
		case "end":
			return "$";
		case "backspace":
			return "h";
		case "delete":
			return "x";
		case "space":
			return "l";
		default:
			return keyId;
	}
}

function accumulateCount(state: ModalState, digit: string): ModalUpdate {
	return invalidate({ ...state, count: state.count * 10 + Number(digit) });
}

function handleNormal(state: ModalState, snapshot: Snapshot, data: string, keyId: string | undefined): ModalUpdate {
	if (keyId === "escape") return delegate(clearPending(state), data);
	if (isProtectedKey(keyId)) return delegate(clearPending(state), data);
	if (isDigit(keyId) && (keyId !== "0" || state.count > 0)) return accumulateCount(state, keyId);

	const action = NORMAL_KEYS[mapNavigationKey(keyId) ?? ""];
	if (!action) return invalidate(clearPending(state));

	switch (action.type) {
		case "motion":
			return normalMotion(state, snapshot, action.motion);
		case "operator":
			return normalOperator(state, snapshot, action.operator);
		case "charSearch":
			return update(
				{
					...clearPending(state),
					pendingCharSearch: { operator: state.pendingOperator, kind: action.kind },
					pendingOperatorCount: state.pendingOperator ? state.pendingOperatorCount : 0,
				},
				[{ type: "invalidate" }],
			);
		case "insert":
			return normalInsert(state, snapshot, action.entry);
		case "deleteChar":
			return emitEdit(clearPending(state), deleteCharAt(snapshot.text, snapshot.cursor, state.count || 1));
		case "substituteChar": {
			const next = clearPending({ ...state, mode: "insert" });
			return emitEdit(next, deleteCharAt(snapshot.text, snapshot.cursor, state.count || 1));
		}
		case "replaceChar":
			return invalidate({ ...clearPending(state), pendingReplace: true });
		case "joinLines": {
			let result: EditResult = { text: snapshot.text, cursor: snapshot.cursor, changed: false };
			for (let index = 0; index < Math.max(1, state.count || 1); index++) {
				result = joinLineWithNext(result.text, result.cursor);
			}
			return emitEdit(clearPending(state), result);
		}
		case "paste": {
			let result: EditResult = { text: snapshot.text, cursor: snapshot.cursor, changed: false };
			for (let index = 0; index < Math.max(1, state.count || 1); index++) {
				result = action.after
					? pasteRegister(result.text, result.cursor, state.register)
					: pasteRegisterBefore(result.text, result.cursor, state.register);
			}
			return emitEdit(clearPending(state), result);
		}
		case "undo":
			return update(clearPending(state), [{ type: "adapterCommand", command: "undo" }]);
		case "redo":
			return update(clearPending(state), [{ type: "adapterCommand", command: "redo" }]);
		case "visual":
			return update(
				clearPending({ ...state, mode: action.linewise ? "visualLine" : "visual", visualAnchor: snapshot.cursor }),
				[{ type: "invalidate" }],
			);
		case "search":
			return update(clearPending({ ...state, pendingSearch: { query: "", direction: action.direction } }), [
				{ type: "invalidate" },
			]);
		case "searchRepeat": {
			const next = clearPending(state);
			if (!state.lastSearch) return invalidate(next);
			const direction: SearchDirection = action.reverse
				? state.lastSearch.direction === "forward"
					? "backward"
					: "forward"
				: state.lastSearch.direction;
			const found = findSearchMatch(snapshot.text, snapshot.cursor, state.lastSearch.query, direction);
			return found ? update(next, [{ type: "restoreCursor", position: found }]) : invalidate(next);
		}
	}
}

function normalMotion(state: ModalState, snapshot: Snapshot, motion: string): ModalUpdate {
	const count = state.count || 1;
	const base = clearPending(state);
	if (state.pendingOperator) {
		const combined = Math.max(1, state.pendingOperatorCount) * count;
		return applyOperatorMotion(base, snapshot, state.pendingOperator, motion, combined);
	}
	if (motion === "up" || motion === "down") {
		const effects: ModalEffect[] = [];
		for (let index = 0; index < count; index++) effects.push({ type: "adapterCommand", command: motion });
		return update(base, effects);
	}
	const target = motionTargetPosition(snapshot.text, snapshot.cursor, motion, count);
	return target ? update(base, [{ type: "restoreCursor", position: target }]) : invalidate(base);
}

function normalOperator(state: ModalState, snapshot: Snapshot, operator: OperatorName): ModalUpdate {
	// Double-tap (dd/cc/yy) runs the linewise form immediately.
	if (state.pendingOperator === operator) {
		const count = Math.max(1, state.pendingOperatorCount) * Math.max(1, state.count || 1);
		const base = clearPending(state);
		if (operator === "yank") {
			const register = yankLineCount(snapshot.text, snapshot.cursor, count);
			return update({ ...base, register }, [{ type: "invalidate" }]);
		}
		const result =
			operator === "change"
				? changeLine(snapshot.text, snapshot.cursor, count)
				: deleteLine(snapshot.text, snapshot.cursor, count);
		const next = operator === "change" ? { ...base, mode: "insert" as VimMode } : base;
		return emitEdit(next, result);
	}
	if (state.pendingOperator) return invalidate(clearPending(state)); // e.g. d then y: cancel
	return invalidate({ ...state, pendingOperator: operator, pendingOperatorCount: state.count, count: 0 });
}

function applyOperatorMotion(
	state: ModalState,
	snapshot: Snapshot,
	operator: OperatorName,
	motion: string,
	count: number,
): ModalUpdate {
	if (operator === "yank") {
		const register = yankByMotion(snapshot.text, snapshot.cursor, motion, count);
		return update({ ...state, register }, [{ type: "invalidate" }]);
	}
	const result = deleteByMotion(snapshot.text, snapshot.cursor, motion, count);
	const next = operator === "change" ? { ...state, mode: "insert" as VimMode } : state;
	return emitEdit(next, result);
}

function normalInsert(state: ModalState, snapshot: Snapshot, entry: InsertEntry): ModalUpdate {
	const count = Math.max(1, state.count || 1);
	const next = clearPending({ ...state, mode: "insert" });
	switch (entry) {
		case "before":
			return update(next, []);
		case "after": {
			const effects: ModalEffect[] = [];
			if (!cursorAtLineEnd(snapshot)) effects.push({ type: "adapterCommand", command: "right" });
			return update(next, effects);
		}
		case "lineStart":
			return update(next, [
				{ type: "restoreCursor", position: firstNonBlankPosition(snapshot.text, snapshot.cursor) },
			]);
		case "lineEnd":
			return update(next, [{ type: "adapterCommand", command: "lineEnd" }]);
		case "openBelow": {
			let result: EditResult = { text: snapshot.text, cursor: snapshot.cursor, changed: false };
			for (let index = 0; index < count; index++) result = openLineBelow(result.text, result.cursor);
			return emitEdit(next, result);
		}
		case "openAbove": {
			let result: EditResult = { text: snapshot.text, cursor: snapshot.cursor, changed: false };
			for (let index = 0; index < count; index++) result = openLineAbove(result.text, result.cursor);
			return emitEdit(next, result);
		}
		case "changeToEnd": {
			const lines = splitText(snapshot.text);
			const pos = clampPosition(lines, snapshot.cursor);
			const start = positionToOffset(snapshot.text, pos);
			const result = deleteOffsetRange(snapshot.text, start, start + ((lines[pos.line]?.length ?? 0) - pos.col));
			return emitEdit(next, result);
		}
	}
}

/** Attach an edit effect, or just invalidate when nothing changed. */
function emitEdit(state: ModalState, result: EditResult): ModalUpdate {
	if (!result.changed) return invalidate(state);
	const next = result.register ? { ...state, register: result.register } : state;
	return update(next, [{ type: "edit", result }]);
}

// ── visual modes ──

function handleVisual(state: ModalState, snapshot: Snapshot, data: string, keyId: string | undefined): ModalUpdate {
	const linewise = state.mode === "visualLine";
	if (keyId === "escape") {
		return update(clearPending({ ...state, mode: "normal", visualAnchor: undefined }), [{ type: "invalidate" }]);
	}
	if (isProtectedKey(keyId)) return delegate(clearPending(state), data);
	if (isDigit(keyId) && (keyId !== "0" || state.count > 0)) return accumulateCount(state, keyId);

	const action = VISUAL_KEYS[mapNavigationKey(keyId) ?? ""];
	if (!action) return invalidate(clearPending(state));

	const anchor = state.visualAnchor ?? snapshot.cursor;
	const count = state.count || 1;

	switch (action.type) {
		case "motion":
			return visualMotion(state, snapshot, action.motion, count);
		case "operator":
			return visualOperator(state, snapshot, anchor, linewise, action.operator);
		case "charSearch":
			return update(
				{
					...clearPending(state),
					pendingCharSearch: { operator: state.pendingOperator, kind: action.kind },
					visualAnchor: anchor,
				},
				[{ type: "invalidate" }],
			);
		case "visual": {
			const togglingOff = action.linewise ? state.mode === "visualLine" : state.mode === "visual";
			if (togglingOff)
				return update(clearPending({ ...state, mode: "normal", visualAnchor: undefined }), [
					{ type: "invalidate" },
				]);
			return update(clearPending({ ...state, mode: action.linewise ? "visualLine" : "visual" }), [
				{ type: "invalidate" },
			]);
		}
		case "joinLines": {
			const result = joinLineWithNext(snapshot.text, { line: Math.min(anchor.line, snapshot.cursor.line), col: 0 });
			return emitEdit(clearPending({ ...state, mode: "normal", visualAnchor: undefined }), result);
		}
		case "replaceChar": {
			if (!linewise) {
				return emitEdit(
					clearPending(state),
					replaceVisualRange(snapshot.text, anchor, snapshot.cursor, false, " "),
				);
			}
			return update({ ...clearPending(state), pendingReplace: true, visualAnchor: anchor }, [
				{ type: "invalidate" },
			]);
		}
		case "paste": {
			// Paste over the selection: delete it, then paste at the resulting cursor.
			const deleted = linewise
				? deleteVisualLines(snapshot.text, anchor, snapshot.cursor)
				: deleteVisualChars(snapshot.text, anchor, snapshot.cursor);
			if (!deleted.changed) return invalidate(clearPending(state));
			const pasted = action.after
				? pasteRegister(deleted.text, deleted.cursor, state.register)
				: pasteRegisterBefore(deleted.text, deleted.cursor, state.register);
			const combined: EditResult = { ...pasted, register: deleted.register ?? pasted.register };
			return emitEdit(clearPending({ ...state, mode: "normal", visualAnchor: undefined }), combined);
		}
		case "search":
			return update(
				clearPending({ ...state, pendingSearch: { query: "", direction: action.direction }, visualAnchor: anchor }),
				[{ type: "invalidate" }],
			);
		case "searchRepeat": {
			const next = clearPending(state);
			if (!state.lastSearch) return invalidate(next);
			const direction: SearchDirection = action.reverse
				? state.lastSearch.direction === "forward"
					? "backward"
					: "forward"
				: state.lastSearch.direction;
			const found = findSearchMatch(snapshot.text, snapshot.cursor, state.lastSearch.query, direction);
			return found ? update(next, [{ type: "restoreCursor", position: found }]) : invalidate(next);
		}
		case "insert":
		case "deleteChar":
		case "substituteChar":
		case "undo":
		case "redo":
			return invalidate(clearPending(state));
	}
}

function visualMotion(state: ModalState, snapshot: Snapshot, motion: string, count: number): ModalUpdate {
	const base = clearPending(state);
	if (motion === "up" || motion === "down") {
		const effects: ModalEffect[] = [];
		for (let index = 0; index < count; index++) effects.push({ type: "adapterCommand", command: motion });
		return update(base, effects);
	}
	const target = motionTargetPosition(snapshot.text, snapshot.cursor, motion, count);
	return target ? update(base, [{ type: "restoreCursor", position: target }]) : invalidate(base);
}

function visualOperator(
	state: ModalState,
	snapshot: Snapshot,
	anchor: Position,
	linewise: boolean,
	operator: OperatorName,
): ModalUpdate {
	const base = clearPending({ ...state, mode: operator === "change" ? "insert" : "normal", visualAnchor: undefined });
	if (operator === "yank") {
		const selected = linewise
			? linewiseSelectionText(snapshot.text, anchor, snapshot.cursor)
			: selectionText(snapshot.text, anchor, snapshot.cursor);
		const register: VimRegister | undefined =
			selected.length > 0 ? { type: linewise ? "line" : "char", text: selected } : undefined;
		return update({ ...base, register }, [{ type: "invalidate" }]);
	}
	if (operator === "change") {
		if (linewise) {
			const startLine = Math.min(anchor.line, snapshot.cursor.line);
			const endLine = Math.max(anchor.line, snapshot.cursor.line);
			return emitEdit(base, changeLine(snapshot.text, { line: startLine, col: 0 }, endLine - startLine + 1));
		}
		return emitEdit(base, deleteVisualChars(snapshot.text, anchor, snapshot.cursor));
	}
	return emitEdit(
		base,
		linewise
			? deleteVisualLines(snapshot.text, anchor, snapshot.cursor)
			: deleteVisualChars(snapshot.text, anchor, snapshot.cursor),
	);
}

// ── pending states ──

function handlePendingSearch(state: ModalState, snapshot: Snapshot, keyId: string | undefined): ModalUpdate {
	const pending = state.pendingSearch;
	if (!pending) return invalidate(state);
	if (keyId === "escape") {
		return update(clearPending({ ...state, pendingSearch: undefined }), [{ type: "invalidate" }]);
	}
	if (keyId === "enter") {
		const next = clearPending({
			...state,
			pendingSearch: undefined,
			lastSearch: { query: pending.query, direction: pending.direction },
		});
		if (pending.query.length === 0) return invalidate(next);
		const found = findSearchMatch(snapshot.text, snapshot.cursor, pending.query, pending.direction);
		return found ? update(next, [{ type: "restoreCursor", position: found }]) : invalidate(next);
	}
	if (keyId === "backspace") {
		return update({ ...state, pendingSearch: { ...pending, query: pending.query.slice(0, -1) } }, [
			{ type: "invalidate" },
		]);
	}
	const char = printableChar(keyId);
	if (char)
		return update({ ...state, pendingSearch: { ...pending, query: pending.query + char } }, [{ type: "invalidate" }]);
	return invalidate(state);
}

function handlePendingCharSearch(state: ModalState, snapshot: Snapshot, keyId: string | undefined): ModalUpdate {
	const pending = state.pendingCharSearch;
	if (!pending) return invalidate(state);
	if (keyId === "escape") {
		return update(clearPending({ ...state, pendingCharSearch: undefined }), [{ type: "invalidate" }]);
	}
	const char = printableChar(keyId);
	if (!char) return invalidate(state);
	const count = Math.max(1, state.pendingOperatorCount || state.count || 1);
	const base = clearPending({ ...state, pendingCharSearch: undefined, count: 0 });

	if (pending.operator) {
		const range = charSearchOperatorOffsetRange(snapshot.text, snapshot.cursor, pending.kind, char, count);
		if (!range) return invalidate(base);
		const operator = pending.operator;
		if (operator === "yank") {
			const selected = snapshot.text.slice(range.start, range.end);
			return update({ ...base, register: selected.length > 0 ? { type: "char", text: selected } : undefined }, [
				{ type: "invalidate" },
			]);
		}
		const result = deleteOffsetRange(snapshot.text, range.start, range.end);
		const next = operator === "change" ? { ...base, mode: "insert" as VimMode } : base;
		return emitEdit(next, result);
	}

	const found = findCharOnLine(snapshot.text, snapshot.cursor, pending.kind, char, count);
	return found ? update(base, [{ type: "restoreCursor", position: found }]) : invalidate(base);
}

function handlePendingReplace(state: ModalState, snapshot: Snapshot, keyId: string | undefined): ModalUpdate {
	if (keyId === "escape") {
		return update(clearPending({ ...state, pendingReplace: false }), [{ type: "invalidate" }]);
	}
	const char = printableChar(keyId);
	if (!char) return invalidate(state);
	const base = clearPending({ ...state, pendingReplace: false });
	if ((state.mode === "visual" || state.mode === "visualLine") && state.visualAnchor) {
		const result = replaceVisualRange(
			snapshot.text,
			state.visualAnchor,
			snapshot.cursor,
			state.mode === "visualLine",
			char,
		);
		return emitEdit({ ...base, mode: "normal", visualAnchor: undefined }, result);
	}
	return emitEdit(base, replaceCharAt(snapshot.text, snapshot.cursor, char, Math.max(1, state.count || 1)));
}
