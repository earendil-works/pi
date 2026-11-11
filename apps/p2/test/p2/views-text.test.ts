// A text room's model (plugins/views/text.ts) and its client half (plugins/views/kit/text-client.ts): edits by ID,
// the drop rules, stored documents checked before use, and two editors converging through one server order.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ElementId, IdList } from "articulated";
import { TextClient } from "../../plugins/views/kit/text-client.ts";
import {
	applyEdit,
	applyEdits,
	editsTo,
	freshText,
	loadText,
	MAX_TEXT,
	saveText,
	type TextDoc,
	type TextEdit,
} from "../../plugins/views/text.ts";

const ids = (prefix: string) => {
	let n = 0;
	return (_before: unknown, count: number) => {
		const id = { bunchId: `${prefix}${n}`, counter: 0 };
		n += count;
		return id;
	};
};

/** The server: applies batches in arrival order, as the room does, and keeps the log. */
class Server {
	doc: TextDoc;
	readonly log: { editor: string; n: number; edits: TextEdit[] }[] = [];
	constructor(text: string) {
		this.doc = freshText(text, "base");
	}
	receive(editor: string, n: number, edits: TextEdit[]): void {
		this.doc = applyEdits(this.doc, edits);
		this.log.push({ editor, n, edits });
	}
}

describe("text model", () => {
	it("inserts after an ID and deletes a range by IDs", () => {
		const doc = freshText("hello", "b");
		const inserted = applyEdit(doc, {
			kind: "insert",
			before: doc.ids.at(4),
			id: { bunchId: "x", counter: 0 },
			content: " world",
			inWord: false,
		});
		assert.equal(inserted.text, "hello world");
		const deleted = applyEdit(inserted, {
			kind: "delete",
			start: inserted.ids.at(0),
			end: inserted.ids.at(5),
			length: 6,
		});
		assert.equal(deleted.text, "world");
		assert.equal(deleted.ids.length, 5);
	});

	it("drops inserts at unknown places, with taken or overlapping IDs, bad counters, or past the limit", () => {
		const doc = freshText("abc", "b");
		const insert = (before: ElementId | null, bunchId: string, counter: number, content: string) =>
			applyEdit(doc, { kind: "insert", before, id: { bunchId, counter }, content, inWord: false });
		assert.equal(insert({ bunchId: "nope", counter: 0 }, "x", 0, "z"), doc, "unknown before");
		assert.equal(insert(null, "b", 1, "z"), doc, "a taken ID");
		// (b, 9) is free but its second character would be (b, 10): with (b, 10) known, the whole insert is dropped.
		const known = applyEdit(doc, {
			kind: "insert",
			before: null,
			id: { bunchId: "b", counter: 10 },
			content: "q",
			inWord: false,
		});
		assert.equal(
			applyEdit(known, {
				kind: "insert",
				before: null,
				id: { bunchId: "b", counter: 9 },
				content: "zz",
				inWord: false,
			}),
			known,
			"an overlapping range",
		);
		assert.equal(insert(null, "x", -1, "z"), doc, "a negative counter");
		assert.equal(insert(null, "x", 1.5, "z"), doc, "a fractional counter");
		assert.equal(insert(null, "x", Number.MAX_SAFE_INTEGER, "zz"), doc, "a range past safe integers");
		assert.equal(insert(null, "x", 0, "z".repeat(MAX_TEXT)), doc, "past the limit");
	});

	it("drops a delete whose range grew by more than ten characters, and an in-word insert after a deleted character", () => {
		const doc = freshText("abcdef", "b");
		const grown = applyEdit(doc, {
			kind: "insert",
			before: doc.ids.at(2),
			id: { bunchId: "x", counter: 0 },
			content: "0123456789AB",
			inWord: false,
		});
		assert.equal(applyEdit(grown, { kind: "delete", start: doc.ids.at(1), end: doc.ids.at(4), length: 4 }), grown);
		const cut = applyEdit(doc, { kind: "delete", start: doc.ids.at(2), end: doc.ids.at(2), length: 1 });
		assert.equal(
			applyEdit(cut, {
				kind: "insert",
				before: doc.ids.at(2),
				id: { bunchId: "y", counter: 0 },
				content: "Z",
				inWord: true,
			}),
			cut,
		);
	});

	it("loads only valid stored documents", () => {
		const doc = freshText("hello", "b");
		const saved = saveText(doc, { e1: 3 });
		assert.equal(loadText(JSON.parse(JSON.stringify(saved)))?.doc.text, "hello");
		// Unchanged text with other IDs: the count no longer matches.
		const fewer = {
			...saved,
			textIds: IdList.new().insertAfter(null, { bunchId: "z", counter: 0 }, 3).saveCompact(),
		};
		assert.equal(loadText(JSON.parse(JSON.stringify(fewer))), undefined);
		assert.equal(loadText({ ...saved, text: "x".repeat(MAX_TEXT + 1) } as never), undefined, "over the limit");
		assert.equal(
			loadText({ text: "a", textIds: { bunchIds: ["b"], signedCounts: ["x"] }, textMarks: {} } as never),
			undefined,
		);
		assert.equal(
			loadText({
				text: "ab",
				textIds: { bunchIds: ["b", "b"], signedCounts: [1, 1], startCounterDeltas: [1], startCounterValues: [0] },
				textMarks: {},
			}),
			undefined,
			"duplicate IDs",
		);
		assert.equal(loadText({ ...saved, textMarks: { e1: -1 } } as never), undefined, "a bad watermark");
		assert.equal(loadText(null), undefined);
	});

	it("computes the edits between two texts", () => {
		const doc = freshText("the cat sat", "b");
		const edits = editsTo(doc, "the dog sat", ids("n"));
		assert.equal(applyEdits(doc, edits).text, "the dog sat");
		assert.deepEqual(
			edits.map((edit) => edit.kind),
			["delete", "insert"],
		);
	});
});

describe("two editors through one order", () => {
	/** Runs `a` and `b`'s inputs concurrently against one server; both clients end equal to the server's text. */
	const converge = (start: string, a: string, b: string) => {
		const server = new Server(start);
		const left = new TextClient("A", server.doc);
		const right = new TextClient("B", server.doc);
		const fromA = left.input(a);
		const fromB = right.input(b);
		if (fromB) server.receive("B", fromB.n, [...fromB.edits]);
		if (fromA) server.receive("A", fromA.n, [...fromA.edits]);
		for (const entry of server.log) {
			left.confirm(entry.editor, entry.n, entry.edits);
			right.confirm(entry.editor, entry.n, entry.edits);
		}
		assert.equal(left.pending.length, 0);
		assert.equal(right.pending.length, 0);
		assert.equal(left.doc.text, server.doc.text);
		assert.equal(right.doc.text, server.doc.text);
		return server.doc.text;
	};

	it("keeps both of two concurrent inserts at one spot", () => {
		const text = converge("ab", "aXb", "aYb");
		assert.ok(text === "aXYb" || text === "aYXb", text);
	});

	it("deletes another's insert inside a deleted range", () => {
		assert.equal(converge("abcdef", "af", "abcZdef"), "af");
	});

	it("replays pending edits over others' confirmed ones", () => {
		const server = new Server("one two");
		const left = new TextClient("A", server.doc);
		const right = new TextClient("B", server.doc);
		const first = right.input("one two three");
		assert.ok(first);
		server.receive("B", first.n, [...first.edits]);
		left.input("zero one two");
		// A sees B's edit while its own is pending: its text shows both.
		left.confirm("B", first.n, first.edits);
		assert.equal(left.doc.text, "zero one two three");
	});

	it("leaves pending a reset's base already holds", () => {
		const server = new Server("x");
		const client = new TextClient("A", server.doc);
		const batch = client.input("xy");
		assert.ok(batch);
		server.receive("A", batch.n, [...batch.edits]);
		client.reset(server.doc, batch.n);
		assert.equal(client.pending.length, 0);
		assert.equal(client.doc.text, "xy");
	});
});
