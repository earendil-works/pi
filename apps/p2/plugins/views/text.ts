// A text room's model (docs/rooms.md, jot's id-based editing): the text and its element IDs (articulated's `IdList`,
// deleted IDs kept as tombstones), edits that name IDs instead of indices, and how each applies. Shared by the server,
// which applies every edit and owns the state, and the view kit, which applies the server's log the same way: the
// rules are deterministic functions of (state, edit), so every replica that applies one log in order agrees.

import type { JsonValue } from "@p2/app/v1";
import { type CompactSavedIdList, type ElementId, IdList } from "articulated";

/** The most a text room's text may hold, in UTF-16 code units: an insert past it is dropped. */
export const MAX_TEXT = 100_000;
/** A delete whose range grew by more than this since it was made (text others inserted inside) is dropped. */
const GROWTH = 10;

/** One edit: insert `content` right after `before` (null: at the start), or delete what lies from `start` to `end`. */
export type TextEdit =
	| {
			readonly kind: "insert";
			readonly before: ElementId | null;
			readonly id: ElementId;
			readonly content: string;
			/** Typed inside a word: dropped when `before` was deleted meanwhile (never half of a deleted word back). */
			readonly inWord: boolean;
	  }
	| { readonly kind: "delete"; readonly start: ElementId; readonly end: ElementId; readonly length: number };

/** A text and its IDs: present ID `i` is character `i`. Immutable: every change returns a new one. */
export type TextDoc = { readonly text: string; readonly ids: IdList };

/** The text room's stored form: the text, its IDs, and each editor's last batch (its watermark). */
export type SavedText = {
	readonly text: string;
	readonly textIds: CompactSavedIdList;
	readonly textMarks: Readonly<Record<string, number>>;
};

/** A text with fresh IDs (one bunch, `bunch`). */
export function freshText(text: string, bunch: string): TextDoc {
	const clipped = text.slice(0, MAX_TEXT);
	return {
		text: clipped,
		ids: clipped.length
			? IdList.new().insertAfter(null, { bunchId: bunch, counter: 0 }, clipped.length)
			: IdList.new(),
	};
}

/**
 * The document stored in `saved`, if it is a valid one: a text within the limit, IDs that load and number exactly its
 * characters, watermarks of safe integers. Anything else (an old shape, a damaged or forged document) is undefined.
 */
export function loadText(saved: JsonValue | undefined): { doc: TextDoc; marks: Record<string, number> } | undefined {
	if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return undefined;
	const { text, textIds, textMarks } = saved;
	if (typeof text !== "string" || text.length > MAX_TEXT || !isCompact(textIds)) return undefined;
	if (textMarks === null || typeof textMarks !== "object" || Array.isArray(textMarks)) return undefined;
	const marks: Record<string, number> = {};
	for (const [editor, mark] of Object.entries(textMarks)) {
		if (typeof mark !== "number" || !Number.isSafeInteger(mark) || mark < 0) return undefined;
		marks[editor] = mark;
	}
	try {
		const ids = IdList.loadCompact(textIds);
		return ids.length === text.length ? { doc: { text, ids }, marks } : undefined;
	} catch {
		return undefined;
	}
}

/** A compact saved list's shape (its content is checked by `IdList.loadCompact`). */
function isCompact(value: JsonValue | undefined): value is CompactSavedIdList & JsonValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const { bunchIds, signedCounts, startCounterDeltas, startCounterValues } = value;
	const ints = (list: JsonValue | undefined) =>
		Array.isArray(list) && list.every((each) => typeof each === "number" && Number.isSafeInteger(each));
	return (
		Array.isArray(bunchIds) &&
		bunchIds.every((each) => typeof each === "string") &&
		ints(signedCounts) &&
		ints(startCounterDeltas) &&
		ints(startCounterValues) &&
		Array.isArray(signedCounts) &&
		signedCounts.length === bunchIds.length
	);
}

/** `doc` and `marks` as stored. */
export function saveText(doc: TextDoc, marks: Readonly<Record<string, number>>): SavedText {
	return { text: doc.text, textIds: doc.ids.saveCompact(), textMarks: marks };
}

/** `doc` after `edit`, or `doc` itself when the rules drop it (unknown or taken IDs, a stale range, the limit). */
export function applyEdit(doc: TextDoc, edit: TextEdit): TextDoc {
	return edit.kind === "insert" ? applyInsert(doc, edit) : applyDelete(doc, edit);
}

function applyInsert(doc: TextDoc, edit: Extract<TextEdit, { kind: "insert" }>): TextDoc {
	const { before, id, content } = edit;
	if (!content || doc.text.length + content.length > MAX_TEXT) return doc;
	// The whole range of IDs the insert takes must be safe integers; articulated refuses one that overlaps a known ID.
	if (!Number.isSafeInteger(id.counter) || id.counter < 0 || !Number.isSafeInteger(id.counter + content.length))
		return doc;
	if (before !== null && !doc.ids.isKnown(before)) return doc;
	if (edit.inWord && before !== null && !doc.ids.has(before)) return doc;
	let ids: IdList;
	try {
		ids = doc.ids.insertAfter(before, id, content.length);
	} catch {
		return doc;
	}
	const at = before === null ? 0 : doc.ids.indexOf(before, "left") + 1;
	return { text: doc.text.slice(0, at) + content + doc.text.slice(at), ids };
}

function applyDelete(doc: TextDoc, edit: Extract<TextEdit, { kind: "delete" }>): TextDoc {
	if (!doc.ids.isKnown(edit.start) || !doc.ids.isKnown(edit.end)) return doc;
	const start = doc.ids.indexOf(edit.start, "right");
	const end = doc.ids.indexOf(edit.end, "left");
	if (end < start || end - start + 1 > edit.length + GROWTH) return doc;
	return { text: doc.text.slice(0, start) + doc.text.slice(end + 1), ids: doc.ids.deleteRange(start, end + 1) };
}

/** Applies `edits` in order. */
export function applyEdits(doc: TextDoc, edits: readonly TextEdit[]): TextDoc {
	let next = doc;
	for (const edit of edits) next = applyEdit(next, edit);
	return next;
}

/**
 * The edits that turn `doc`'s text into `next`: a delete of what changed and an insert of what replaces it (the common
 * start and end kept), with new IDs from `newId(before, count)`.
 */
export function editsTo(
	doc: TextDoc,
	next: string,
	newId: (before: ElementId | null, count: number) => ElementId,
): TextEdit[] {
	const old = doc.text;
	let prefix = 0;
	const shorter = Math.min(old.length, next.length);
	while (prefix < shorter && old.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
	let suffix = 0;
	while (
		suffix < shorter - prefix &&
		old.charCodeAt(old.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
	)
		suffix++;
	const edits: TextEdit[] = [];
	const removed = old.length - suffix - prefix;
	if (removed > 0)
		edits.push({
			kind: "delete",
			start: doc.ids.at(prefix),
			end: doc.ids.at(prefix + removed - 1),
			length: removed,
		});
	const content = next.slice(prefix, next.length - suffix);
	if (content) {
		const before = prefix > 0 ? doc.ids.at(prefix - 1) : null;
		edits.push({
			kind: "insert",
			before,
			id: newId(before, content.length),
			content,
			inWord: prefix > 0 && WORD.test(old.charAt(prefix - 1)) && WORD.test(content.charAt(0)),
		});
	}
	return edits;
}

const WORD = /[\p{L}\p{N}_]/u;
