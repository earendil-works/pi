import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";

// We'll implement these
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../src/utils.js";

const chalk = new Chalk({ level: 3 });

describe("wrapTextWithAnsi", () => {
	it("wraps plain text at word boundaries", () => {
		const text = "hello world this is a test";
		const lines = wrapTextWithAnsi(text, 15);

		assert.strictEqual(lines.length, 2);
		assert.strictEqual(lines[0], "hello world");
		assert.strictEqual(lines[1], "this is a test");
	});

	it("preserves ANSI codes across wrapped lines", () => {
		const text = chalk.bold("hello world this is bold text");
		const lines = wrapTextWithAnsi(text, 20);

		// Should have bold code at start of each line
		assert.ok(lines[0].includes("\x1b[1m"));
		assert.ok(lines[1].includes("\x1b[1m"));

		// Each line should be <= 20 visible chars
		assert.ok(visibleWidth(lines[0]) <= 20);
		assert.ok(visibleWidth(lines[1]) <= 20);
	});

	it("handles text with resets", () => {
		const text = chalk.bold("bold ") + "normal " + chalk.cyan("cyan");
		const lines = wrapTextWithAnsi(text, 30);

		assert.strictEqual(lines.length, 1);
		// Should contain the reset code from chalk
		assert.ok(lines[0].includes("\x1b["));
	});

	it("does not resurrect foreground color after a 39m reset on wrapped continuation lines", () => {
		const red = "\x1b[31m";
		const resetFg = "\x1b[39m";
		const text = `${red}red${resetFg} plain words here`;
		const lines = wrapTextWithAnsi(text, 8);

		assert.ok(lines.length > 1);
		assert.ok(!lines[1]?.startsWith(red), `unexpected stale foreground carry: ${JSON.stringify(lines)}`);
	});

	it("does NOT pad lines", () => {
		const text = "hello";
		const lines = wrapTextWithAnsi(text, 20);

		assert.strictEqual(lines.length, 1);
		assert.strictEqual(visibleWidth(lines[0]), 5); // NOT 20
	});

	it("handles empty text", () => {
		const lines = wrapTextWithAnsi("", 20);
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0], "");
	});

	it("handles newlines", () => {
		const text = "line1\nline2\nline3";
		const lines = wrapTextWithAnsi(text, 20);

		assert.strictEqual(lines.length, 3);
		assert.strictEqual(lines[0], "line1");
		assert.strictEqual(lines[1], "line2");
		assert.strictEqual(lines[2], "line3");
	});
});

describe("applyBackgroundToLine", () => {
	const greenBg = (text: string) => chalk.bgGreen(text);

	it("applies background to plain text and pads to width", () => {
		const line = "hello";
		const result = applyBackgroundToLine(line, 20, greenBg);

		// Should be exactly 20 visible chars
		const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
		assert.strictEqual(stripped.length, 20);

		// Should have background codes
		assert.ok(result.includes("\x1b[48") || result.includes("\x1b[42m"));
		assert.ok(result.includes("\x1b[49m"));
	});

	it("handles text with ANSI codes and resets", () => {
		const line = chalk.bold("hello") + " world";
		const result = applyBackgroundToLine(line, 20, greenBg);

		// Should be exactly 20 visible chars
		const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
		assert.strictEqual(stripped.length, 20);

		// Should still have bold
		assert.ok(result.includes("\x1b[1m"));

		// Should have background throughout (even after resets)
		assert.ok(result.includes("\x1b[48") || result.includes("\x1b[42m"));
	});

	it("handles text with 0m resets by reapplying background", () => {
		// Simulate: bold text + reset + normal text
		const line = "\x1b[1mhello\x1b[0m world";
		const result = applyBackgroundToLine(line, 20, greenBg);

		// Should NOT have black cells (spaces without background)
		// Pattern we DON'T want: 49m or 0m followed by spaces before bg reapplied
		const blackCellPattern = /(\x1b\[49m|\x1b\[0m)\s+\x1b\[48;2/;
		assert.ok(!blackCellPattern.test(result), `Found black cells in: ${JSON.stringify(result)}`);

		// Should be exactly 20 chars
		const stripped = result.replace(/\x1b\[[0-9;]*m/g, "");
		assert.strictEqual(stripped.length, 20);
	});
});
