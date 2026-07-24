import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Container, Text } from "../src/index.ts";

describe("Container memoization", () => {
	it("returns same array reference when no child changed", () => {
		const container = new Container();
		const text1 = new Text("First message");
		const text2 = new Text("Second message");

		container.addChild(text1);
		container.addChild(text2);

		// First render
		const lines1 = container.render(80);
		assert.ok(Array.isArray(lines1), "Should return an array");
		assert.ok(lines1.length > 0, "Should have lines");

		// Second render with no changes - should return same reference
		const lines2 = container.render(80);
		assert.strictEqual(lines2, lines1, "Should return same array reference when nothing changed");
	});

	it("returns new array when child invalidates", () => {
		const container = new Container();
		const text1 = new Text("First message");
		const text2 = new Text("Second message");

		container.addChild(text1);
		container.addChild(text2);

		const lines1 = container.render(80);

		// Invalidate a child
		text1.invalidate();

		// Should return new array reference
		const lines2 = container.render(80);
		assert.notStrictEqual(lines2, lines1, "Should return new array after child invalidates");
	});

	it("returns new array when child content changes", () => {
		const container = new Container();
		const text1 = new Text("First message");
		const text2 = new Text("Second message");

		container.addChild(text1);
		container.addChild(text2);

		const lines1 = container.render(80);

		// Change child content
		text2.setText("Modified message");

		// Should return new array reference
		const lines2 = container.render(80);
		assert.notStrictEqual(lines2, lines1, "Should return new array after child content changes");
	});

	it("returns new array when child added or removed", () => {
		const container = new Container();
		const text1 = new Text("First message");

		container.addChild(text1);
		const lines1 = container.render(80);

		// Add a child
		const text2 = new Text("Second message");
		container.addChild(text2);

		const lines2 = container.render(80);
		assert.notStrictEqual(lines2, lines1, "Should return new array after child added");

		// Remove a child
		container.children.pop();
		const lines3 = container.render(80);
		assert.notStrictEqual(lines3, lines2, "Should return new array after child removed");
	});
});
