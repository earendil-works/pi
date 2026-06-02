import assert from "node:assert";
import { describe, it } from "node:test";
import { visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

describe("wrapTextWithAnsi CJK", () => {
	it("should break Chinese text between characters, not only at spaces", () => {
		const text = "这是一段中文，用来测试折行问题，这个问题在混合英文 word 的时候会发生。";
		const lines = wrapTextWithAnsi(text, 30);

		// All lines should be within width
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 30, `Line "${line}" exceeds width`);
		}

		// Should produce more than 2 lines (old behavior was 3 lines with poor wrapping)
		assert.ok(lines.length >= 3);

		// No line should be just a single English word stranded alone
		for (const line of lines) {
			const stripped = line.trim();
			if (stripped.length > 0) {
				// No line should be just "word" or just "TUI"
				assert.ok(!/^[a-zA-Z]{1,5}$/.test(stripped), `Line "${stripped}" is just an isolated English word`);
			}
		}
	});

	it("should not strand English words on their own line (TUI case)", () => {
		const text = "但如果你是在某个编辑器或 pi 的 TUI 里看到模板展开后也出现类似问题";
		const lines = wrapTextWithAnsi(text, 30);

		// All lines should be within width
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 30, `Line "${line}" exceeds width`);
		}

		// TUI should not be alone on a line
		for (const line of lines) {
			assert.ok(line.trim() !== "TUI", "TUI should not be stranded on its own line");
		}
	});

	it("should wrap English text the same as before", () => {
		const text = "This is a normal English sentence that should wrap at word boundaries";
		const lines = wrapTextWithAnsi(text, 30);

		assert.strictEqual(lines[0], "This is a normal English");
		assert.strictEqual(lines[1], "sentence that should wrap at");
		assert.strictEqual(lines[2], "word boundaries");
	});

	it("should not start a line with line-start prohibited punctuation", () => {
		const text = "你好世界，测试一下。再来一段；看看效果";
		const lines = wrapTextWithAnsi(text, 10);

		for (const line of lines) {
			const trimmed = line.trimStart();
			// Should not start with CJK comma, period, or semicolon
			assert.ok(
				!/^[\uff0c\u3002\uff1b\uff01\uff1f]/.test(trimmed),
				`Line starts with prohibited punctuation: "${trimmed}"`,
			);
		}
	});

	it("should not end a line with line-end prohibited punctuation", () => {
		const text = "这是一个很长的句子\uff08括号里有内容\uff09后面还有文字继续写下去";
		const lines = wrapTextWithAnsi(text, 15);

		for (const line of lines) {
			const trimmed = line.trimEnd();
			// Should not end with opening brackets or quotes
			assert.ok(
				!/(\uff08|\u300c|\u3010|\u300a|\(|\[|\{)$/.test(trimmed),
				`Line ends with prohibited punctuation: "${trimmed}"`,
			);
		}
	});
});
