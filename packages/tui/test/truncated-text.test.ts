import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";
import { TruncatedText } from "../src/components/truncated-text.ts";
import { visibleWidth } from "../src/utils.ts";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

describe("TruncatedText component", () => {
	it("pads output lines to exactly match width", () => {
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(50);

		// Should have exactly one content line (no vertical padding)
		assert.strictEqual(lines.length, 1);

		// Line should be exactly 50 visible characters
		const visibleLen = visibleWidth(lines[0]);
		assert.strictEqual(visibleLen, 50);
	});

	it("pads output with vertical padding lines to width", () => {
		const text = new TruncatedText("Hello", 0, 2);
		const lines = text.render(40);

		// Should have 2 padding lines + 1 content line + 2 padding lines = 5 total
		assert.strictEqual(lines.length, 5);

		// All lines should be exactly 40 characters
		for (const line of lines) {
			assert.strictEqual(visibleWidth(line), 40);
		}
	});

	it("truncates long text and pads to width", () => {
		const longText = "This is a very long piece of text that will definitely exceed the available width";
		const text = new TruncatedText(longText, 1, 0);
		const lines = text.render(30);

		assert.strictEqual(lines.length, 1);

		// Should be exactly 30 characters
		assert.strictEqual(visibleWidth(lines[0]), 30);

		// Should contain ellipsis
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(stripped.includes("..."));
	});

	it("preserves ANSI codes in output and pads correctly", () => {
		const styledText = `${chalk.red("Hello")} ${chalk.blue("world")}`;
		const text = new TruncatedText(styledText, 1, 0);
		const lines = text.render(40);

		assert.strictEqual(lines.length, 1);

		// Should be exactly 40 visible characters (ANSI codes don't count)
		assert.strictEqual(visibleWidth(lines[0]), 40);

		// Should preserve the color codes
		assert.ok(lines[0].includes("\x1b["));
	});

	it("truncates styled text and adds reset code before ellipsis", () => {
		const longStyledText = chalk.red("This is a very long red text that will be truncated");
		const text = new TruncatedText(longStyledText, 1, 0);
		const lines = text.render(20);

		assert.strictEqual(lines.length, 1);

		// Should be exactly 20 visible characters
		assert.strictEqual(visibleWidth(lines[0]), 20);

		// Should contain reset code before ellipsis
		assert.ok(lines[0].includes("\x1b[0m..."));
	});

	it("handles text that fits exactly", () => {
		// With paddingX=1, available width is 30-2=28
		// "Hello world" is 11 chars, fits comfortably
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(30);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(visibleWidth(lines[0]), 30);

		// Should NOT contain ellipsis
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(!stripped.includes("..."));
	});

	it("handles empty text", () => {
		const text = new TruncatedText("", 1, 0);
		const lines = text.render(30);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(visibleWidth(lines[0]), 30);
	});

	it("stops at newline and only shows first line", () => {
		const multilineText = "First line\nSecond line\nThird line";
		const text = new TruncatedText(multilineText, 1, 0);
		const lines = text.render(40);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(visibleWidth(lines[0]), 40);

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
		assert.strictEqual(visibleWidth(lines[0]), 25);

		// Should contain ellipsis and not second line
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(stripped.includes("..."));
		assert.ok(!stripped.includes("Second line"));
	});
});
