import assert from "node:assert";
import { describe, it } from "node:test";
import { normalizeTerminalOutput, truncateToWidth, visibleWidth } from "../src/utils.ts";

describe("truncateToWidth", () => {
	it("keeps output within width for very large unicode input", () => {
		const text = "🙂界".repeat(100_000);
		const truncated = truncateToWidth(text, 40, "…");

		assert.ok(visibleWidth(truncated) <= 40);
		assert.strictEqual(truncated.endsWith("…\x1b[0m"), true);
	});

	it("preserves ANSI styling for kept text and resets before and after ellipsis", () => {
		const text = `\x1b[31m${"hello ".repeat(1000)}\x1b[0m`;
		const truncated = truncateToWidth(text, 20, "…");

		assert.ok(visibleWidth(truncated) <= 20);
		assert.strictEqual(truncated.includes("\x1b[31m"), true);
		assert.strictEqual(truncated.endsWith("\x1b[0m…\x1b[0m"), true);
	});

	it("handles malformed ANSI escape prefixes without hanging", () => {
		const text = `abc\x1bnot-ansi ${"🙂".repeat(1000)}`;
		const truncated = truncateToWidth(text, 20, "…");

		assert.ok(visibleWidth(truncated) <= 20);
	});

	it("clips wide ellipsis safely and brackets it with resets", () => {
		assert.strictEqual(truncateToWidth("abcdef", 1, "🙂"), "");
		assert.strictEqual(truncateToWidth("abcdef", 2, "🙂"), "\x1b[0m🙂\x1b[0m");
		assert.ok(visibleWidth(truncateToWidth("abcdef", 2, "🙂")) <= 2);
	});

	it("returns the original text when it already fits even if ellipsis is too wide", () => {
		assert.strictEqual(truncateToWidth("a", 2, "🙂"), "a");
		assert.strictEqual(truncateToWidth("界", 2, "🙂"), "界");
	});

	it("pads truncated output to requested width", () => {
		const truncated = truncateToWidth("🙂界🙂界🙂界", 8, "…", true);
		assert.strictEqual(visibleWidth(truncated), 8);
	});

	it("adds a trailing reset when truncating without an ellipsis", () => {
		const truncated = truncateToWidth(`\x1b[31m${"hello".repeat(100)}`, 10, "");
		assert.ok(visibleWidth(truncated) <= 10);
		assert.strictEqual(truncated.endsWith("\x1b[0m"), true);
	});

	it("keeps a contiguous prefix instead of skipping a wide grapheme and resuming later", () => {
		const truncated = truncateToWidth("🙂\t界 \x1b_abc\x07", 7, "…", true);
		assert.strictEqual(truncated, "🙂\t\x1b[0m…\x1b[0m ");
	});
});

describe("visibleWidth", () => {
	it("counts tabs inline and skips ANSI inline", () => {
		assert.strictEqual(visibleWidth("\t\x1b[31m界\x1b[0m"), 5);
	});

	it("counts Indic conjunct spacing code points within grapheme clusters", () => {
		assert.strictEqual(visibleWidth("र्क"), 2);
		assert.strictEqual(visibleWidth("नेटवर्क"), 5);
		assert.strictEqual(visibleWidth("सर्वाधिकार सुरक्षित। ऑर्डर पर क्लिक करें"), 33);
		assert.strictEqual(visibleWidth("র্ক"), 2);
		assert.strictEqual(visibleWidth("ર્ક"), 2);
		assert.strictEqual(visibleWidth("ର୍କ"), 2);
		assert.strictEqual(visibleWidth("ర్క"), 2);
		assert.strictEqual(visibleWidth("ര്‍ക"), 2);
	});

	it("keeps ordinary combining marks zero-width", () => {
		assert.strictEqual(visibleWidth("e\u0301"), 1);
		assert.strictEqual(visibleWidth("čřžůú"), 5);
		assert.strictEqual(visibleWidth("שָׁ"), 1);
		assert.strictEqual(visibleWidth("بّ"), 1);
		assert.strictEqual(visibleWidth("རྐ"), 1);
		assert.strictEqual(visibleWidth("ᜠ᜴"), 1);
		assert.strictEqual(visibleWidth("가〮"), 2);
		assert.strictEqual(visibleWidth("가〯"), 2);
	});

	it("keeps CJK and Japanese width accounting unchanged", () => {
		assert.strictEqual(visibleWidth("网络"), 4);
		assert.strictEqual(visibleWidth("ネットワーク"), 12);
		assert.strictEqual(visibleWidth("が"), 2);
		assert.strictEqual(visibleWidth("か\u3099"), 2);
	});

	it("counts Myanmar marks that terminals allocate cells for", () => {
		assert.strictEqual(visibleWidth("ကာ"), 2);
		assert.strictEqual(visibleWidth("ကေ"), 2);
		assert.strictEqual(visibleWidth("က်"), 2);
		assert.strictEqual(visibleWidth("ကျ"), 2);
		assert.strictEqual(visibleWidth("ကြ"), 2);
		assert.strictEqual(visibleWidth("ကဳ"), 2);
		assert.strictEqual(visibleWidth("ကဴ"), 2);
		assert.strictEqual(visibleWidth("ကဵ"), 2);
		assert.strictEqual(visibleWidth("ကး"), 2);
		assert.strictEqual(visibleWidth("ကို"), 1);
		assert.strictEqual(visibleWidth("က္"), 1);
	});

	it("keeps Thai and Lao AM clusters at their normal cell width", () => {
		assert.strictEqual(visibleWidth("ำ"), 1);
		assert.strictEqual(visibleWidth("ຳ"), 1);
		assert.strictEqual(visibleWidth("กำ"), 2);
		assert.strictEqual(visibleWidth("ກຳ"), 2);
	});

	it("normalizes Thai and Lao AM vowels only for terminal output", () => {
		assert.strictEqual(normalizeTerminalOutput("ำ"), "ํา");
		assert.strictEqual(normalizeTerminalOutput("ຳ"), "ໍາ");
		assert.strictEqual(visibleWidth(normalizeTerminalOutput("ำabc")), visibleWidth("ำabc"));
		assert.strictEqual(visibleWidth(normalizeTerminalOutput("ຳabc")), visibleWidth("ຳabc"));
	});
});
