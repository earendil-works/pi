import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";
import { TruncatedText } from "../src/components/truncated-text.ts";
import { visibleWidth } from "../src/utils.ts";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

describe("TruncatedText component", () => {
	it("does not pad output lines to full width", () => {
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(50);

		// Should have exactly one content line (no vertical padding)
		assert.strictEqual(lines.length, 1);

		// Line should contain the text with left/right padding but NOT
		// be padded to the full width — trailing cells stay empty so
		// xterm.js trims whitespace on copy.
		const visibleLen = visibleWidth(lines[0]);
		assert.strictEqual(visibleLen, 13); // 1 + 11 + 1
	});

	it("vertical padding lines are empty", () => {
		const text = new TruncatedText("Hello", 0, 2);
		const lines = text.render(40);

		// Should have 2 padding lines + 1 content line + 2 padding lines = 5 total
		assert.strictEqual(lines.length, 5);

		// Padding lines should be empty (not space-filled)
		assert.strictEqual(lines[0], "");
		assert.strictEqual(lines[1], "");
		assert.strictEqual(lines[3], "");
		assert.strictEqual(lines[4], "");

		// Content line should contain text but not be padded to width
		assert.strictEqual(visibleWidth(lines[2]), 5);
	});

	it("truncates long text with ellipsis", () => {
		const longText = "This is a very long piece of text that will definitely exceed the available width";
		const text = new TruncatedText(longText, 1, 0);
		const lines = text.render(30);

		assert.strictEqual(lines.length, 1);

		// Should not exceed 30 characters (content width 28 + 2 padding)
		assert.ok(visibleWidth(lines[0]) <= 30);

		// Should contain ellipsis
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(stripped.includes("..."));
	});

	it("preserves ANSI codes in output", () => {
		const styledText = `${chalk.red("Hello")} ${chalk.blue("world")}`;
		const text = new TruncatedText(styledText, 1, 0);
		const lines = text.render(40);

		assert.strictEqual(lines.length, 1);

		// Visible width should be content + padding, not padded to 40
		assert.strictEqual(visibleWidth(lines[0]), 13); // 1 + 11 + 1

		// Should preserve the color codes
		assert.ok(lines[0].includes("\x1b["));
	});

	it("truncates styled text and adds reset code before ellipsis", () => {
		const longStyledText = chalk.red("This is a very long red text that will be truncated");
		const text = new TruncatedText(longStyledText, 1, 0);
		const lines = text.render(20);

		assert.strictEqual(lines.length, 1);

		// Should not exceed 20 visible characters
		assert.ok(visibleWidth(lines[0]) <= 20);

		// Should contain reset code before ellipsis
		assert.ok(lines[0].includes("\x1b[0m..."));
	});

	it("handles text that fits without truncation", () => {
		// With paddingX=1, available width is 30-2=28
		// "Hello world" is 11 chars, fits comfortably
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(30);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(visibleWidth(lines[0]), 13); // 1 + 11 + 1

		// Should NOT contain ellipsis
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(!stripped.includes("..."));
	});

	it("handles empty text", () => {
		const text = new TruncatedText("", 1, 0);
		const lines = text.render(30);

		assert.strictEqual(lines.length, 1);
		// Empty text with paddingX=1: just left + right padding
		assert.strictEqual(visibleWidth(lines[0]), 2);
	});

	it("stops at newline and only shows first line", () => {
		const multilineText = "First line\nSecond line\nThird line";
		const text = new TruncatedText(multilineText, 1, 0);
		const lines = text.render(40);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(visibleWidth(lines[0]), 12); // 1 + 10 + 1

		// Should only contain "First line"
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "").trim();
		assert.ok(stripped.includes("First line"));
		assert.ok(!stripped.includes("Second line"));
		assert.ok(!stripped.includes("Third line"));
	});

	it("truncates first line even with newlines in text", () => {
		const longMultilineText = "This is a very long first line that needs truncation\nSecond line";
		const text = new TruncatedText(longMultilineText, 1, 0);
		const lines = text.render(25);

		assert.strictEqual(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= 25);

		// Should contain ellipsis and not second line
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(stripped.includes("..."));
		assert.ok(!stripped.includes("Second line"));
	});
});
