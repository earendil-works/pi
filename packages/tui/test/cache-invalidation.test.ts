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
});
