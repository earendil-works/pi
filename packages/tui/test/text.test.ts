import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";

describe("Text", () => {
	it("keeps its wrapped lines when the same text is set again", () => {
		const text = new Text("hello world", 0, 0);
		const lines = text.render(5);
		text.setText("hello world");
		assert.strictEqual(text.render(5), lines);
	});
});
