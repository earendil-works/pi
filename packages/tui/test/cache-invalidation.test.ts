import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme, Text } from "../src/index.js";

const plainTheme: MarkdownTheme = {
	heading: (t) => t,
	link: (t) => t,
	linkUrl: (t) => t,
	code: (t) => t,
	codeBlock: (t) => t,
	codeBlockBorder: (t) => t,
	quote: (t) => t,
	quoteBorder: (t) => t,
	hr: (t) => t,
	listBullet: (t) => t,
	bold: (t) => t,
	italic: (t) => t,
	strikethrough: (t) => t,
	underline: (t) => t,
};

describe("Render caching", () => {
	it("Markdown.setText does not invalidate cache when text is unchanged", () => {
		const md = new Markdown("hello", 0, 0, plainTheme);
		const lines1 = md.render(20);
		md.setText("hello");
		const lines2 = md.render(20);
		assert.strictEqual(lines2, lines1);
	});

	it("Text.setText does not invalidate cache when text is unchanged", () => {
		const t = new Text("hello", 0, 0);
		const lines1 = t.render(20);
		t.setText("hello");
		const lines2 = t.render(20);
		assert.strictEqual(lines2, lines1);
	});

	it("Text reuses cached output when revisiting a previous width", () => {
		const t = new Text("hello world repeated to wrap across multiple widths", 0, 0);
		const lines20 = t.render(20);
		t.render(18);
		const lines20Again = t.render(20);
		assert.strictEqual(lines20Again, lines20);
	});

	it("Markdown reuses cached output when revisiting a previous width", () => {
		const md = new Markdown("- hello world\n- repeated markdown content", 0, 0, plainTheme);
		const lines20 = md.render(20);
		md.render(18);
		const lines20Again = md.render(20);
		assert.strictEqual(lines20Again, lines20);
	});
});
