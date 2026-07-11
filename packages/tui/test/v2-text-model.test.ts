import assert from "node:assert";
import { describe, it } from "node:test";
import { DefaultTextLayout } from "../src/v2/text-layout.ts";
import { TextModel } from "../src/v2/text-model.ts";

describe("TextModel", () => {
	it("moves and deletes by grapheme cluster", () => {
		const family = "👨‍👩‍👧‍👦";
		const model = new TextModel(`a${family}b`);
		model.apply({ type: "move", direction: "left" });
		assert.strictEqual(model.cursor().offset, 1 + family.length);
		model.apply({ type: "deleteBackward" });
		assert.strictEqual(model.text(), "ab");
		assert.strictEqual(model.cursor().offset, 1);
	});

	it("reuses word navigation, kill ring accumulation, yank, and undo", () => {
		const model = new TextModel("one two three");
		model.apply({ type: "kill", direction: "wordBackward" });
		model.apply({ type: "kill", direction: "wordBackward" });
		assert.strictEqual(model.text(), "one ");
		model.apply({ type: "yank" });
		assert.strictEqual(model.text(), "one two three");
		model.apply({ type: "undo" });
		assert.strictEqual(model.text(), "one ");
	});

	it("keeps a sticky grapheme column during vertical movement", () => {
		const model = new TextModel("abcd\nx\nwxyz", 4);
		model.apply({ type: "move", direction: "down" });
		assert.strictEqual(model.cursor().offset, 6);
		model.apply({ type: "move", direction: "down" });
		assert.strictEqual(model.cursor().offset, 11);
		model.apply({ type: "move", direction: "up" });
		assert.strictEqual(model.cursor().offset, 6);
	});

	it("replaces normalized selections and emits deterministic changes", () => {
		const model = new TextModel("abcdef", 0);
		const changes: string[] = [];
		model.onChange.subscribe((change) => changes.push(change.text));
		model.apply({ type: "select", range: { start: 5, end: 2 } });
		assert.deepStrictEqual(model.selection(), { start: 2, end: 5 });
		model.apply({ type: "insert", text: "X" });
		assert.strictEqual(model.text(), "abXf");
		assert.deepStrictEqual(changes, ["abXf"]);
	});
});

describe("DefaultTextLayout", () => {
	it("wraps on grapheme boundaries and maps a continuation caret", () => {
		const model = new TextModel("ab🙂c", "ab🙂".length);
		const layout = new DefaultTextLayout();
		assert.deepStrictEqual(
			layout.wrap(model, 4).map((line) => ({ text: line.text, width: line.width })),
			[
				{ text: "ab🙂", width: 4 },
				{ text: "c", width: 1 },
			],
		);
		assert.deepStrictEqual(layout.caretCell(model, 4), { row: 1, column: 0 });
	});

	it("keeps the caret before a hard newline on the preceding visual line", () => {
		const model = new TextModel("ab\nc", 2);
		const layout = new DefaultTextLayout();
		assert.deepStrictEqual(layout.caretCell(model, 10), { row: 0, column: 2 });
		model.apply({ type: "move", direction: "right" });
		assert.deepStrictEqual(layout.caretCell(model, 10), { row: 1, column: 0 });
	});

	it("never produces an overwidth visual line for randomized unicode", () => {
		const clusters = ["a", "界", "🙂", "👨‍👩‍👧‍👦", "é", "ำ", " ", "\n"];
		let state = 17;
		const layout = new DefaultTextLayout();
		for (let sample = 0; sample < 200; sample++) {
			let text = "";
			for (let index = 0; index < 80; index++) {
				state = (state * 1103515245 + 12345) >>> 0;
				text += clusters[state % clusters.length];
			}
			const width = 2 + (sample % 11);
			for (const line of layout.wrap(new TextModel(text), width)) {
				assert.ok(line.width <= width, `line width ${line.width} exceeded ${width}: ${JSON.stringify(line.text)}`);
			}
		}
	});
});
