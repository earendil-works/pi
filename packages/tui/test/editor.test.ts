import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { getCursorAccentBgAnsi, getCursorAccentFgAnsi } from "../src/cursor.js";
import { defaultEditorTheme } from "./test-themes.js";

describe("Editor component", () => {
	it("renders the cursor with the editor instance accent colors", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.handleInput("a");

		const rendered = editor.render(10).join("\n");

		assert.ok(rendered.includes("\x1b[38;5;15m"));
		assert.ok(rendered.includes("\x1b[48;5;27m"));
		assert.ok(!rendered.includes(getCursorAccentBgAnsi()));
		assert.ok(!rendered.includes(getCursorAccentFgAnsi()));
	});

	describe("Unicode text editing behavior", () => {
		it("inserts mixed ASCII, umlauts, and emojis as literal text", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("H");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput(" ");
			editor.handleInput("😀");

			const text = editor.getText();
			assert.strictEqual(text, "Hello äöü 😀");
		});

		it("deletes single-code-unit unicode characters (umlauts) with Backspace", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			// Delete the last character (ü)
			editor.handleInput("\x7f"); // Backspace

			const text = editor.getText();
			assert.strictEqual(text, "äö");
		});

		it("deletes multi-code-unit emojis with repeated Backspace", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");

			// Delete the last emoji (👍) - requires 2 backspaces since emojis are 2 code units
			editor.handleInput("\x7f"); // Backspace
			editor.handleInput("\x7f"); // Backspace

			const text = editor.getText();
			assert.strictEqual(text, "😀");
		});

		it("inserts characters at the correct position after cursor movement over umlauts", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			// Move cursor left twice
			editor.handleInput("\x1b[D"); // Left arrow
			editor.handleInput("\x1b[D"); // Left arrow

			// Insert 'x' in the middle
			editor.handleInput("x");

			const text = editor.getText();
			assert.strictEqual(text, "äxöü");
		});

		it("moves cursor in code units across multi-code-unit emojis before insertion", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");
			editor.handleInput("🎉");

			// Move cursor left over last emoji (🎉)
			editor.handleInput("\x1b[D"); // Left arrow
			editor.handleInput("\x1b[D"); // Left arrow

			// Move cursor left over second emoji (👍)
			editor.handleInput("\x1b[D");
			editor.handleInput("\x1b[D");

			// Insert 'x' between first and second emoji
			editor.handleInput("x");

			const text = editor.getText();
			assert.strictEqual(text, "😀x👍🎉");
		});

		it("preserves umlauts across line breaks", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput("\n"); // new line
			editor.handleInput("Ä");
			editor.handleInput("Ö");
			editor.handleInput("Ü");

			const text = editor.getText();
			assert.strictEqual(text, "äöü\nÄÖÜ");
		});

		it("replaces the entire document with unicode text via setText (paste simulation)", () => {
			const editor = new Editor(defaultEditorTheme);

			// Simulate bracketed paste / programmatic replacement
			editor.setText("Hällö Wörld! 😀 äöüÄÖÜß");

			const text = editor.getText();
			assert.strictEqual(text, "Hällö Wörld! 😀 äöüÄÖÜß");
		});

		it("expands large paste markers in getExpandedText without changing visible editor text", () => {
			const editor = new Editor(defaultEditorTheme);
			const pasted = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

			editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);

			assert.strictEqual(editor.getText(), "[paste #1 +20 lines]");
			assert.strictEqual(editor.getExpandedText(), pasted);
		});

		it("moves cursor to document start on Ctrl+A and inserts at the beginning", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("\x01"); // Ctrl+A (move to start)
			editor.handleInput("x"); // Insert at start

			const text = editor.getText();
			assert.strictEqual(text, "xab");
		});
	});

	describe("Word-by-word navigation", () => {
		it("moves cursor left by word with Option+Left (ESC+b)", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("hello world test");

			// Cursor is at end (position 16)
			editor.handleInput("\x1bb"); // Option+Left (ESC+b) - move to start of "test"

			// Insert 'X' to verify cursor position
			editor.handleInput("X");

			const text = editor.getText();
			assert.strictEqual(text, "hello world Xtest");
		});

		it("moves cursor right by word with Option+Right (ESC+f)", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("hello world test");

			// Move cursor to beginning
			editor.handleInput("\x01"); // Ctrl+A

			editor.handleInput("\x1bf"); // Option+Right (ESC+f) - move past "hello "

			// Insert 'X' to verify cursor position
			editor.handleInput("X");

			const text = editor.getText();
			assert.strictEqual(text, "hello Xworld test");
		});

		it("moves cursor left by word with Ctrl+Left (CSI 1;5D)", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("foo bar baz");

			// Cursor is at end
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left - move to start of "baz"

			editor.handleInput("X");

			const text = editor.getText();
			assert.strictEqual(text, "foo bar Xbaz");
		});

		it("moves cursor right by word with Ctrl+Right (CSI 1;5C)", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("foo bar baz");

			editor.handleInput("\x01"); // Ctrl+A - move to start

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right - move past "foo "

			editor.handleInput("X");

			const text = editor.getText();
			assert.strictEqual(text, "foo Xbar baz");
		});

		it("handles punctuation as word boundaries when moving left", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("hello.world");

			// Cursor at end (position 11)
			editor.handleInput("\x1bb"); // move to start of "world"

			editor.handleInput("X");

			const text = editor.getText();
			assert.strictEqual(text, "hello.Xworld");
		});

		it("handles punctuation as word boundaries when moving right", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("hello.world");

			editor.handleInput("\x01"); // move to start

			editor.handleInput("\x1bf"); // move past "hello"

			editor.handleInput("X");

			const text = editor.getText();
			assert.strictEqual(text, "helloX.world");
		});

		it("moves to previous line when at start of line (word left)", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("line one\nline two");

			// Move to start of second line
			editor.handleInput("\x1b[B"); // Down arrow
			editor.handleInput("\x01"); // Ctrl+A - start of line

			editor.handleInput("\x1bb"); // Option+Left - should go to end of first line

			editor.handleInput("X");

			const text = editor.getText();
			assert.strictEqual(text, "line oneX\nline two");
		});

		it("moves to next line when at end of line (word right)", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("line one\nline two");

			// Cursor is at end of second line after setText
			// Move up to first line
			editor.handleInput("\x1b[A"); // Up arrow
			// Move to end of first line
			editor.handleInput("\x05"); // Ctrl+E - end of line

			// First word-right moves to start of second line
			editor.handleInput("\x1bf"); // Option+Right - should go to start of second line
			// Second word-right moves past "line "
			editor.handleInput("\x1bf"); // Option+Right - move past "line "

			editor.handleInput("X");

			const text = editor.getText();
			assert.strictEqual(text, "line one\nline Xtwo");
		});

		it("skips multiple spaces when moving by word", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("hello    world");

			editor.handleInput("\x1bb"); // move left by word

			editor.handleInput("X");

			const text = editor.getText();
			assert.strictEqual(text, "hello    Xworld");
		});
	});

	describe("Display-line cursor navigation (soft wrap)", () => {
		it("moves up/down through wrapped display lines", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = undefined; // Disable scrollbar to get exact width
			// Create a line that will wrap at width 10
			// "abcdefghij" = 10 chars, "klmno" = 5 chars
			// At width 10, this wraps into 2 display lines
			editor.setText("abcdefghijklmno");

			// Render at width 10 to trigger wrapping
			editor.render(10);

			// Cursor starts at end (position 15)
			// Move to position 3 (within first display line)
			editor.handleInput("\x01"); // Start of line
			editor.handleInput("\x1b[C"); // Right 1
			editor.handleInput("\x1b[C"); // Right 2
			editor.handleInput("\x1b[C"); // Right 3 -> cursor at position 3 ("d")

			// Now move down - should go to position 13 (3 within second display line)
			editor.handleInput("\x1b[B"); // Down

			// Insert X to verify position
			editor.handleInput("X");
			assert.strictEqual(editor.getText(), "abcdefghijklmXno");
		});

		it("wraps left at start of wrapped display line to end of previous", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = undefined;
			editor.setText("abcdefghijklmno");

			// Render at width 10 to trigger wrapping
			editor.render(10);

			// Move cursor to start of second display line (position 10)
			editor.handleInput("\x01"); // Start
			for (let i = 0; i < 10; i++) {
				editor.handleInput("\x1b[C"); // Move right to position 10
			}

			// Now left arrow should go to last character of first display line (position 9)
			editor.handleInput("\x1b[D"); // Left

			// Insert X to verify position - X goes at position 9
			editor.handleInput("X");
			assert.strictEqual(editor.getText(), "abcdefghiXjklmno");
		});

		it("wraps right at end of wrapped display line to start of next", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = undefined;
			editor.setText("abcdefghijklmno");

			// Render at width 10 to trigger wrapping
			editor.render(10);

			// Move cursor to end of first display line (position 10)
			editor.handleInput("\x01"); // Start
			for (let i = 0; i < 10; i++) {
				editor.handleInput("\x1b[C"); // Move right to position 10
			}

			// Now right arrow should go to start of second display line (which is position 10 or 11)
			editor.handleInput("\x1b[C"); // Right

			// Insert X to verify position
			editor.handleInput("X");
			// After position 10 we insert X, so text becomes "abcdefghijkXlmno"
			assert.strictEqual(editor.getText(), "abcdefghijkXlmno");
		});

		it("preserves target column when moving vertically through wrapped lines", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = undefined;
			// Create text that wraps: 3 display lines at width 10
			// Line 1: "0123456789" (indices 0-9)
			// Line 2: "0123456789" (indices 10-19)
			// Line 3: "01234" (indices 20-24)
			editor.setText("012345678901234567890123456789");

			// Render at width 10 to trigger wrapping
			editor.render(10);

			// Start at column 5 of first display line
			editor.handleInput("\x01"); // Start
			for (let i = 0; i < 5; i++) {
				editor.handleInput("\x1b[C");
			}

			// Move down twice
			editor.handleInput("\x1b[B"); // Down to second display line
			editor.handleInput("\x1b[B"); // Down to third display line

			// Insert X to verify - should be at column 5 within third line
			// Third display line starts at index 20, so position should be 25
			// X gets inserted BEFORE position 25, so it appears at index 25
			editor.handleInput("X");
			assert.strictEqual(editor.getText(), "0123456789012345678901234X56789");
		});

		it("clamps target column when moving to shorter wrapped line", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = undefined;
			// Create text with varying wrapped line lengths
			// At width 10: "0123456789" (10 chars) + "012" (3 chars)
			editor.setText("0123456789012");

			// Render at width 10 to trigger wrapping
			editor.render(10);

			// Start at column 8 of first display line
			editor.handleInput("\x01"); // Start
			for (let i = 0; i < 8; i++) {
				editor.handleInput("\x1b[C");
			}

			// Move down to shorter line (only 3 chars)
			editor.handleInput("\x1b[B"); // Down

			// Insert X - should be at end of second line (position 13)
			editor.handleInput("X");
			assert.strictEqual(editor.getText(), "0123456789012X");
		});

		it("handles navigation with emojis (wide characters)", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = undefined;
			// Each emoji is 2 display columns wide
			// At width 10: "😀😀😀😀😀" = 10 display columns (5 emojis, 10 chars)
			// Then "😀" on next line
			editor.setText("😀😀😀😀😀😀");

			// Render at width 10 to trigger wrapping
			editor.render(10);

			// Start at position 0 and move right by 2 emojis
			editor.handleInput("\x01");
			editor.handleInput("\x1b[C"); // First emoji (2 code units each)
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C"); // Second emoji
			editor.handleInput("\x1b[C");

			// Insert X
			editor.handleInput("X");
			assert.strictEqual(editor.getText(), "😀😀X😀😀😀😀");
		});

		it("clamps to end of wrapped line when target column exceeds width", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = undefined;
			// Create text that wraps: 2 display lines at width 10
			// Line 1: "0123456789" (10 chars, indices 0-9)
			// Line 2: "01234" (5 chars, indices 10-14)
			editor.setText("012345678901234");

			// Render at width 10 to trigger wrapping
			editor.render(10);

			// Move cursor to position 9 (within first display line)
			editor.handleInput("\x01"); // Start
			for (let i = 0; i < 9; i++) {
				editor.handleInput("\x1b[C");
			}
			// Now at position 9 (near end of first display line content)

			// Move down - targetDisplayCol is 9, but second line only has 5 chars
			// Should clamp to end of second line (position 15)
			editor.handleInput("\x1b[B"); // Down

			// Insert X - should be at end of second line (position 15)
			editor.handleInput("X");
			assert.strictEqual(editor.getText(), "012345678901234X");
		});
	});

	describe("Height awareness and scrolling", () => {
		it("renders all lines when maxHeight is not set", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("line1\nline2\nline3\nline4\nline5");

			const result = editor.render(20);
			// Should have: top border + 5 content lines + bottom border = 7 lines
			assert.strictEqual(result.length, 7);
		});

		it("constrains visible lines when maxHeight is set", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 3;
			editor.setText("line1\nline2\nline3\nline4\nline5");

			const result = editor.render(20);
			// Should have: top border + 3 visible lines + bottom border = 5 lines
			assert.strictEqual(result.length, 5);
		});

		it("shows scrollbar when content exceeds maxHeight", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 3;
			editor.setText("line1\nline2\nline3\nline4\nline5");

			const result = editor.render(20);
			// Content lines should have scrollbar characters at the end
			// Check that the content lines (not borders) contain scrollbar chars
			const contentLines = result.slice(1, -1);
			const hasScrollbar = contentLines.some((line) => line.includes("█") || line.includes("░"));
			assert.strictEqual(hasScrollbar, true);
		});

		it("auto-scrolls when cursor moves below viewport", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 3;
			editor.setText("line1\nline2\nline3\nline4\nline5");

			// Render to initialize displaySlices
			editor.render(20);

			// Move cursor down multiple times
			editor.handleInput("\x1b[B"); // Down
			editor.handleInput("\x1b[B"); // Down
			editor.handleInput("\x1b[B"); // Down - should trigger scroll
			editor.handleInput("\x1b[B"); // Down - should scroll more

			// Scroll offset should have increased
			assert.ok(editor.getScrollOffset() > 0, "Scroll offset should be > 0 after moving cursor down");
		});

		it("auto-scrolls when cursor moves above viewport", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 3;
			editor.setText("line1\nline2\nline3\nline4\nline5");

			// Render to initialize displaySlices
			editor.render(20);

			// Scroll down first
			editor.setScrollOffset(2);

			// Move cursor to top of document (cursor starts at line 4)
			editor.handleInput("\x01"); // Start of line (Ctrl+A)
			editor.handleInput("\x1b[A"); // Up to line 3
			editor.handleInput("\x1b[A"); // Up to line 2
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0

			// Scroll offset should have decreased to show cursor
			assert.strictEqual(editor.getScrollOffset(), 0, "Scroll offset should be 0 when cursor is at top");
		});

		it("PageDown scrolls by page minus overlap", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 5;
			editor.setText("line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10");

			// Render to initialize
			editor.render(20);

			const initialOffset = editor.getScrollOffset();
			assert.strictEqual(initialOffset, 0);

			// PageDown
			editor.handleInput("\x1b[6~");

			// Should scroll by (5 - 2) = 3 lines
			assert.strictEqual(editor.getScrollOffset(), 3);
		});

		it("PageUp scrolls by page minus overlap", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 5;
			editor.setText("line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10");

			// Render to initialize
			editor.render(20);

			// Scroll down first
			editor.setScrollOffset(5);

			// PageUp
			editor.handleInput("\x1b[5~");

			// Should scroll by (5 - 2) = 3 lines
			assert.strictEqual(editor.getScrollOffset(), 2);
		});

		it("scroll() method respects bounds", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 3;
			editor.setText("line1\nline2\nline3\nline4\nline5");

			// Render to initialize
			editor.render(20);

			// Try to scroll past the end
			editor.scroll(100);
			// Max scroll should be 5 - 3 = 2
			assert.strictEqual(editor.getScrollOffset(), 2);

			// Try to scroll past the beginning
			editor.scroll(-100);
			assert.strictEqual(editor.getScrollOffset(), 0);
		});

		it("handles wrapped lines with height constraint", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 3;
			// Long line that wraps at width 10
			editor.setText("abcdefghijklmnopqrstuvwxyz");

			// Render at width 10 - should create 3 wrapped display lines
			const result = editor.render(10);

			// Should have: top border + 3 visible lines + bottom border = 5 lines
			assert.strictEqual(result.length, 5);
		});

		it("cursor visibility works with soft-wrapped content", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 2;
			// Long line that wraps multiple times at width 10
			editor.setText("abcdefghijklmnopqrstuvwxyz0123456789");

			// Render at width 10
			editor.render(10);

			// After setText, scroll is at 0. Move cursor to trigger auto-scroll
			editor.handleInput("\x1b[B"); // Down (no-op at end, but triggers ensureCursorVisible)

			const scrollOffset = editor.getScrollOffset();
			// The text creates 4 display lines at width 9 (10-1 for scrollbar), cursor at end should scroll
			assert.ok(scrollOffset > 0, "Should have scrolled to show cursor at end");
		});

		it("does not show scrollbar when content fits in maxHeight", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 10;
			editor.setText("line1\nline2\nline3");

			const result = editor.render(20);
			// Content lines should NOT have scrollbar characters
			const contentLines = result.slice(1, -1);
			const hasScrollbar = contentLines.some((line) => line.includes("█") || line.includes("░"));
			assert.strictEqual(hasScrollbar, false);
		});

		it("can hide top and bottom borders", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.showTopBorder = false;
			editor.showBottomBorder = false;
			editor.setText("line1\nline2");

			const result = editor.render(20);

			assert.strictEqual(result.length, 2);
			assert.ok(result.every((line) => !/^─+$/.test(line)));
		});

		it("can render an underline cursor instead of reverse video", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.cursorStyle = "underline";
			editor.setText("hello");
			editor.handleInput("\x1b[D");

			const result = editor.render(20);

			assert.ok(result.some((line) => line.includes("\x1b[4m")));
			assert.ok(result.some((line) => line.includes("\x1b[24m")));
			assert.ok(result.every((line) => !line.includes("\x1b[7m")));
			assert.ok(result.every((line) => !line.includes("\x1b[0m")));
		});

		it("renders an accent block cursor by default when the cursor is on a character", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("hello");
			editor.handleInput("\x1b[D");

			const result = editor.render(20).join("\n");

			assert.match(
				result,
				new RegExp(
					`${defaultEditorTheme.cursorAccentAnsi!.fgAnsi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${defaultEditorTheme.cursorAccentAnsi!.bgAnsi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}o`,
				),
			);
			assert.ok(!result.includes("\x1b[7m"));
			assert.ok(!result.includes("\x1b[4m"));
		});

		it("renders an accent block cursor by default at end of line", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("abc");

			const result = editor.render(20).join("\n");

			assert.ok(
				result.includes(
					`${defaultEditorTheme.cursorAccentAnsi!.fgAnsi}${defaultEditorTheme.cursorAccentAnsi!.bgAnsi} `,
				),
			);
			assert.ok(!result.includes("\x1b[4m \x1b[24m"));
			assert.ok(!result.includes("\x1b[7m \x1b[27m"));
		});
	});

	describe("mouse scrollbar behavior", () => {
		it("ignores clicks outside the scrollbar column", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 4;
			editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));

			editor.render(20);
			assert.strictEqual(editor.getScrollOffset(), 0);

			editor.handleInput("\x1b[<0;1;1M");

			assert.strictEqual(editor.getScrollOffset(), 0, "expected clicks away from the scrollbar to be ignored");
		});

		it("drags the scrollbar thumb to update scroll offset", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.maxHeight = 4;
			editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
			for (let i = 0; i < 30; i++) {
				editor.handleInput("\x1b[A");
			}

			editor.render(20);
			assert.strictEqual(editor.getScrollOffset(), 0);

			editor.handleInput("\x1b[<0;20;2M");
			assert.strictEqual(editor.getScrollOffset(), 0, "expected grabbing the top thumb to keep the current offset");
			editor.handleInput("\x1b[<32;20;5M");

			assert.ok(editor.getScrollOffset() > 0, "expected dragging the scrollbar thumb to scroll the editor");
		});
	});
});
