// File references in a message's text (src/runtime/references.ts) and the composer's undo history
// (plugins/chat/draft-history.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DraftHistory } from "../../plugins/chat/draft-history.ts";
import {
	fileReferences,
	plainReferences,
	referenceParts,
	referenceText,
	renameReferences,
} from "../../src/runtime/references.ts";

describe("file references", () => {
	it("finds embedded and linked references with their names, in order", () => {
		const text = "a ![shot.png](attachment:k1) b [notes.md](attachment:k2)";
		assert.deepEqual(fileReferences(text), [
			{ start: 2, end: 28, image: true, label: "shot.png", id: "k1" },
			{ start: 31, end: 56, image: false, label: "notes.md", id: "k2" },
		]);
	});

	it("round-trips names with brackets and backslashes", () => {
		const token = referenceText("a [b] \\c.png", "k1", true);
		assert.equal(token, "![a \\[b\\] \\\\c.png](attachment:k1)");
		assert.deepEqual(fileReferences(`x${token}y`)[0]?.label, "a [b] \\c.png");
	});

	it("leaves other links and other schemes as text", () => {
		const text = "![x](https://e.test/x.png) [y](file:y) ![z](attachment:) [w](attachment:bad/id)";
		assert.deepEqual(fileReferences(text), []);
	});

	it("splits a text into runs and the references a filter accepts", () => {
		const text = "a [x](attachment:k1) b [y](attachment:k2)";
		assert.deepEqual(
			referenceParts(text, (id) => id === "k2").map((part) => (part.kind === "text" ? part.text : part.id)),
			["a [x](attachment:k1) b ", "k2"],
		);
	});

	it("shows references by name and renames them, unknown ones to their names", () => {
		const text = "see ![a.png](attachment:k1) and [b.txt](attachment:k2)";
		assert.equal(plainReferences(text), "see [a.png] and [b.txt]");
		assert.equal(
			renameReferences(text, (id) => (id === "k1" ? "u1" : undefined)),
			"see ![a.png](attachment:u1) and [b.txt]",
		);
	});
});

describe("draft history", () => {
	it("coalesces typing at the caret and keeps other changes apart", () => {
		const history = new DraftHistory({ text: "", caret: 0 });
		history.record({ text: "h", caret: 1 }, "insert", 0, 1000);
		history.record({ text: "hi", caret: 2 }, "insert", 1, 1100);
		history.record({ text: "hi![a](attachment:k)", caret: 20 }, "edit", 2, 1200);
		assert.deepEqual(history.undo(), { text: "hi", caret: 2 });
		assert.deepEqual(history.undo(), { text: "", caret: 0 });
		assert.equal(history.undo(), undefined);
		assert.deepEqual(history.redo(), { text: "hi", caret: 2 });
		assert.deepEqual(history.redo(), { text: "hi![a](attachment:k)", caret: 20 });
		assert.equal(history.redo(), undefined);
	});

	it("starts a new step after a pause, a jump of the caret or another kind of change", () => {
		const history = new DraftHistory({ text: "", caret: 0 });
		history.record({ text: "a", caret: 1 }, "insert", 0, 0);
		history.record({ text: "ab", caret: 2 }, "insert", 1, 5000);
		history.record({ text: "cab", caret: 1 }, "insert", 0, 5100);
		history.record({ text: "ca", caret: 2 }, "delete", 3, 5200);
		assert.deepEqual(history.undo(), { text: "cab", caret: 3 });
		assert.deepEqual(history.undo(), { text: "ab", caret: 0 });
		assert.deepEqual(history.undo(), { text: "a", caret: 1 });
	});

	it("drops the redo steps when a new change follows an undo", () => {
		const history = new DraftHistory({ text: "", caret: 0 });
		history.record({ text: "a", caret: 1 }, "edit", 0, 0);
		history.undo();
		history.record({ text: "b", caret: 1 }, "edit", 0, 10);
		assert.equal(history.redo(), undefined);
		assert.deepEqual(history.undo(), { text: "", caret: 0 });
	});
});
